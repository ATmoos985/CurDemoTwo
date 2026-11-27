package com.example.cutdemotwo.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * 企业认证与 HMAC-SHA256 令牌服务：
 * <ul>
 *   <li>支持 {@code sys_user} / File PBKDF2WithHmacSHA256 加盐密码校验、首次启动空库平滑播种；</li>
 *   <li>令牌携带 {@code jti}、{@code ver}、{@code actorType}、{@code agentId}、{@code scopes}，支持登出吊销与改密/禁用即时失效；</li>
 *   <li>默认 {@code cutdemo.auth.enabled=false}，保留 5 参构造器向后兼容单元测试。</li>
 * </ul>
 */
@Service
public class AuthService {
    private static final Logger log = LoggerFactory.getLogger(AuthService.class);
    private static final String HMAC_ALGORITHM = "HmacSHA256";
    private static final String DEFAULT_USERS = String.join(";",
            "admin:admin123:ADMIN:系统管理员",
            "planner:planner123:PLANNER:排程计划员",
            "operator:operator123:OPERATOR:裁床操作员",
            "inspector:inspector123:INSPECTOR:质检员",
            "warehouse:warehouse123:WAREHOUSE:仓管员"
    );
    private static final byte[] JWT_HEADER_BYTES =
            "{\"alg\":\"HS256\",\"typ\":\"JWT\"}".getBytes(StandardCharsets.UTF_8);
    private static final String JWT_HEADER_B64 = Base64.getUrlEncoder().withoutPadding().encodeToString(JWT_HEADER_BYTES);
    private static final JsonMapper JSON = JsonMapper.builder().build();

    public record UserAccount(String username, String password, String role, String displayName) {}

    public record LoginResult(String token, String username, String displayName, String role, String expiresAt) {}

    public record MeResponse(
            boolean enabled,
            boolean authenticated,
            String username,
            String displayName,
            String role,
            List<String> roles,
            String actorType,
            String agentId,
            List<String> scopes,
            String expiresAt
    ) {
        public MeResponse(boolean enabled, boolean authenticated, String username, String displayName, String role, List<String> roles) {
            this(enabled, authenticated, username, displayName, role, roles, AuthContext.ACTOR_USER, null, List.of(), null);
        }
    }

    private record VerifiedClaims(AuthContext.Principal principal, long expiresAtEpochSec) {}

    private final boolean enabled;
    private final byte[] secretBytes;
    private final long tokenTtlSeconds;
    private final SecurityCredentialStore credentialStore;
    private final Clock clock;

    @Autowired
    public AuthService(
            @Value("${cutdemo.auth.enabled:false}") boolean enabled,
            @Value("${cutdemo.auth.secret:}") String secret,
            @Value("${cutdemo.auth.users:}") String usersConfig,
            @Value("${cutdemo.auth.token-ttl-hours:12}") long tokenTtlHours,
            SecurityCredentialStore credentialStore
    ) {
        this(enabled, secret, usersConfig, tokenTtlHours, Clock.systemUTC(), credentialStore);
    }

    public AuthService(boolean enabled, String secret, String usersConfig, long tokenTtlHours, Clock clock) {
        this(enabled, secret, usersConfig, tokenTtlHours, clock, new InMemorySecurityCredentialStore());
    }

    public AuthService(
            boolean enabled,
            String secret,
            String usersConfig,
            long tokenTtlHours,
            Clock clock,
            SecurityCredentialStore credentialStore
    ) {
        this.enabled = enabled;
        this.clock = clock == null ? Clock.systemUTC() : clock;
        this.credentialStore = credentialStore == null ? new InMemorySecurityCredentialStore() : credentialStore;
        long ttlHours = tokenTtlHours < 1 ? 12 : tokenTtlHours;
        this.tokenTtlSeconds = ttlHours * 3600L;
        if (secret == null || secret.isBlank()) {
            byte[] random = new byte[32];
            new SecureRandom().nextBytes(random);
            this.secretBytes = random;
            if (enabled) {
                log.warn("cutdemo.auth.secret 未显式配置，已生成进程内随机签名密钥；服务重启后既有令牌将失效");
            }
        } else {
            this.secretBytes = secret.trim().getBytes(StandardCharsets.UTF_8);
        }
        seedInitialUsersIfEmpty(usersConfig);
    }

    public boolean isEnabled() {
        return enabled;
    }

    public Clock getClock() {
        return clock;
    }

    public Optional<LoginResult> authenticate(String username, String password) {
        if (username == null || username.isBlank() || password == null || password.isEmpty()) {
            return Optional.empty();
        }
        String cleanUsername = username.trim();
        Optional<SecurityCredentialStore.UserRecord> found = credentialStore.findUser(cleanUsername);
        if (found.isEmpty()) {
            return Optional.empty();
        }
        SecurityCredentialStore.UserRecord user = found.get();
        if (!user.enabled() || !AuthContext.ALL_ROLES.contains(user.role())) {
            return Optional.empty();
        }
        if (!PasswordHasher.matches(password, user.passwordHash())) {
            return Optional.empty();
        }
        Instant now = clock.instant();
        Instant expiresAt = now.plusSeconds(tokenTtlSeconds);
        try {
            credentialStore.touchUserLastLogin(user.username(), now.toEpochMilli());
        } catch (RuntimeException ex) {
            log.warn("更新用户最近登录时间失败（不影响登录签发）: username={}", user.username(), ex);
        }
        String token = signUserToken(user, now.getEpochSecond(), expiresAt.getEpochSecond());
        return Optional.of(new LoginResult(
                token,
                user.username(),
                user.displayName(),
                user.role(),
                expiresAt.toString()
        ));
    }

    public String issueAgentToken(SecurityCredentialStore.AgentRecord agent, long ttlSeconds) {
        Instant now = clock.instant();
        long effectiveTtl = ttlSeconds > 0 ? ttlSeconds : tokenTtlSeconds;
        long expSec = agent.expiresAt() != null
                ? Math.max(now.getEpochSecond() + 1, agent.expiresAt() / 1000L)
                : now.plusSeconds(effectiveTtl).getEpochSecond();
        return signAgentToken(agent, now.getEpochSecond(), expSec);
    }

    public Optional<AuthContext.Principal> verifyToken(String rawToken) {
        return verifyTokenWithExpiry(rawToken).map(VerifiedClaims::principal);
    }

    public Optional<AuthContext.Principal> verifyAuthorizationHeader(String authorizationHeader) {
        return extractBearerToken(authorizationHeader).flatMap(this::verifyToken);
    }

    public Optional<AuthContext.Principal> revokeTokenByHeader(String authorizationHeader, String reason) {
        Optional<String> tokenOpt = extractBearerToken(authorizationHeader);
        if (tokenOpt.isEmpty()) {
            return Optional.empty();
        }
        Optional<VerifiedClaims> verified = verifyTokenWithExpiry(tokenOpt.get());
        if (verified.isEmpty()) {
            return Optional.empty();
        }
        VerifiedClaims claims = verified.get();
        AuthContext.Principal p = claims.principal();
        if (p.jti() != null && !p.jti().isBlank()) {
            String subjectId = p.isAgent() ? p.agentId() : p.username();
            credentialStore.revokeToken(new SecurityCredentialStore.TokenRevocationRecord(
                    p.jti(),
                    p.actorType(),
                    subjectId,
                    reason == null ? "LOGOUT" : reason,
                    clock.millis(),
                    claims.expiresAtEpochSec() * 1000L
            ));
        }
        return Optional.of(p);
    }

    public void changePassword(String username, String currentPassword, String newPassword) {
        if (username == null || username.isBlank() || AuthContext.LOCAL_PRINCIPAL.username().equals(username)) {
            throw new IllegalArgumentException("当前会话未绑定可修改密码的用户");
        }
        if (currentPassword == null || currentPassword.isEmpty()) {
            throw new IllegalArgumentException("请输入当前密码");
        }
        if (newPassword == null || newPassword.length() < 6) {
            throw new IllegalArgumentException("新密码长度不能少于 6 位");
        }
        SecurityCredentialStore.UserRecord user = credentialStore.findUser(username.trim())
                .orElseThrow(() -> new IllegalArgumentException("用户不存在"));
        if (!user.enabled()) {
            throw new IllegalStateException("账号已被禁用，无法修改密码");
        }
        if (!PasswordHasher.matches(currentPassword, user.passwordHash())) {
            throw new IllegalArgumentException("当前密码不正确");
        }
        credentialStore.updatePassword(user.username(), PasswordHasher.hash(newPassword), clock.millis());
    }

    public MeResponse me(String authorizationHeader) {
        if (!enabled) {
            return new MeResponse(
                    false, false, "LOCAL", "本地免登模式",
                    AuthContext.ROLE_ADMIN, List.of(AuthContext.ROLE_ADMIN),
                    AuthContext.ACTOR_USER, null, List.of(), null
            );
        }
        Optional<VerifiedClaims> verified = extractBearerToken(authorizationHeader).flatMap(this::verifyTokenWithExpiry);
        if (verified.isPresent()) {
            AuthContext.Principal p = verified.get().principal();
            return new MeResponse(
                    true, true, p.username(), p.displayName(), p.role(), p.roles(),
                    p.actorType(), p.agentId(), p.scopes(),
                    Instant.ofEpochSecond(verified.get().expiresAtEpochSec()).toString()
            );
        }
        return new MeResponse(true, false, "", "", "", List.of(), "", null, List.of(), null);
    }

    public static Optional<String> extractBearerToken(String authorizationHeader) {
        if (authorizationHeader == null) {
            return Optional.empty();
        }
        String trimmed = authorizationHeader.trim();
        if (trimmed.length() <= 7 || !trimmed.regionMatches(true, 0, "Bearer ", 0, 7)) {
            return Optional.empty();
        }
        String token = trimmed.substring(7).trim();
        return token.isEmpty() ? Optional.empty() : Optional.of(token);
    }

    private Optional<VerifiedClaims> verifyTokenWithExpiry(String rawToken) {
        if (rawToken == null || rawToken.isBlank()) {
            return Optional.empty();
        }
        String token = rawToken.trim();
        String[] parts = token.split("\\.");
        if (parts.length != 3 || !JWT_HEADER_B64.equals(parts[0])) {
            return Optional.empty();
        }
        byte[] expectedSig = hmacSha256(parts[0] + "." + parts[1]);
        byte[] suppliedSig;
        try {
            suppliedSig = Base64.getUrlDecoder().decode(parts[2]);
        } catch (IllegalArgumentException invalidBase64) {
            return Optional.empty();
        }
        if (!MessageDigest.isEqual(expectedSig, suppliedSig)) {
            return Optional.empty();
        }
        try {
            byte[] payloadBytes = Base64.getUrlDecoder().decode(parts[1]);
            JsonNode payload = JSON.readTree(payloadBytes);
            if (payload == null || !payload.isObject()) {
                return Optional.empty();
            }
            String sub = payload.path("sub").asString("");
            String jti = payload.path("jti").asString("");
            String actorType = payload.path("actorType").asString(AuthContext.ACTOR_USER).toUpperCase(Locale.ROOT);
            long ver = payload.path("ver").asLong(1L);
            long exp = payload.path("exp").asLong(0L);
            if (sub.isBlank() || exp <= clock.instant().getEpochSecond()) {
                return Optional.empty();
            }
            if (!jti.isBlank() && credentialStore.isTokenRevoked(jti)) {
                return Optional.empty();
            }
            if (AuthContext.ACTOR_AGENT.equals(actorType)) {
                return verifyAgentClaims(sub, jti, ver, exp);
            }
            return verifyUserClaims(sub, payload, jti, ver, exp);
        } catch (RuntimeException invalidPayload) {
            return Optional.empty();
        }
    }

    private Optional<VerifiedClaims> verifyUserClaims(String sub, JsonNode payload, String jti, long ver, long exp) {
        String tokenRole = payload.path("role").asString("").toUpperCase(Locale.ROOT);
        if (!AuthContext.ALL_ROLES.contains(tokenRole)) {
            return Optional.empty();
        }
        Optional<SecurityCredentialStore.UserRecord> found = credentialStore.findUser(sub);
        if (found.isEmpty()) {
            return Optional.empty();
        }
        SecurityCredentialStore.UserRecord user = found.get();
        if (!user.enabled() || user.tokenVersion() != ver || !AuthContext.ALL_ROLES.contains(user.role())) {
            return Optional.empty();
        }
        AuthContext.Principal principal = new AuthContext.Principal(
                user.username(),
                user.displayName(),
                user.role(),
                List.of(user.role()),
                true,
                AuthContext.ACTOR_USER,
                null,
                List.of(),
                jti.isBlank() ? null : jti,
                ver
        );
        return Optional.of(new VerifiedClaims(principal, exp));
    }

    private Optional<VerifiedClaims> verifyAgentClaims(String sub, String jti, long ver, long exp) {
        Optional<SecurityCredentialStore.AgentRecord> found = credentialStore.findAgent(sub);
        if (found.isEmpty()) {
            return Optional.empty();
        }
        SecurityCredentialStore.AgentRecord agent = found.get();
        long nowMs = clock.millis();
        if (!agent.enabled() || agent.revokedAt() != null || agent.tokenVersion() != ver) {
            return Optional.empty();
        }
        if (agent.expiresAt() != null && agent.expiresAt() <= nowMs) {
            return Optional.empty();
        }
        List<String> effectiveScopes = agent.scopes().stream()
                .filter(AuthContext.AGENT_ALLOWED_SCOPES::contains)
                .distinct()
                .toList();
        AuthContext.Principal principal = new AuthContext.Principal(
                "agent:" + agent.agentId(),
                agent.name(),
                AuthContext.ROLE_AGENT,
                List.of(AuthContext.ROLE_AGENT),
                true,
                AuthContext.ACTOR_AGENT,
                agent.agentId(),
                effectiveScopes,
                jti.isBlank() ? null : jti,
                ver
        );
        return Optional.of(new VerifiedClaims(principal, exp));
    }

    private String signUserToken(SecurityCredentialStore.UserRecord user, long issuedAtEpochSec, long expiresAtEpochSec) {
        Map<String, Object> claims = new LinkedHashMap<>();
        claims.put("jti", UUID.randomUUID().toString());
        claims.put("sub", user.username());
        claims.put("name", user.displayName());
        claims.put("actorType", AuthContext.ACTOR_USER);
        claims.put("role", user.role());
        claims.put("ver", user.tokenVersion());
        claims.put("iat", issuedAtEpochSec);
        claims.put("exp", expiresAtEpochSec);
        return encodeJwt(claims);
    }

    private String signAgentToken(SecurityCredentialStore.AgentRecord agent, long issuedAtEpochSec, long expiresAtEpochSec) {
        Map<String, Object> claims = new LinkedHashMap<>();
        claims.put("jti", UUID.randomUUID().toString());
        claims.put("sub", agent.agentId());
        claims.put("name", agent.name());
        claims.put("actorType", AuthContext.ACTOR_AGENT);
        claims.put("role", AuthContext.ROLE_AGENT);
        claims.put("agentId", agent.agentId());
        claims.put("scopes", agent.scopes());
        claims.put("ver", agent.tokenVersion());
        claims.put("iat", issuedAtEpochSec);
        claims.put("exp", expiresAtEpochSec);
        return encodeJwt(claims);
    }

    private String encodeJwt(Map<String, Object> claims) {
        byte[] payloadBytes = JSON.writeValueAsBytes(claims);
        String payloadB64 = Base64.getUrlEncoder().withoutPadding().encodeToString(payloadBytes);
        String signingInput = JWT_HEADER_B64 + "." + payloadB64;
        String sigB64 = Base64.getUrlEncoder().withoutPadding().encodeToString(hmacSha256(signingInput));
        return signingInput + "." + sigB64;
    }

    private byte[] hmacSha256(String content) {
        try {
            Mac mac = Mac.getInstance(HMAC_ALGORITHM);
            mac.init(new SecretKeySpec(secretBytes, HMAC_ALGORITHM));
            return mac.doFinal(content.getBytes(StandardCharsets.UTF_8));
        } catch (GeneralSecurityException error) {
            throw new IllegalStateException("HMAC-SHA256 签名初始化失败", error);
        }
    }

    private void seedInitialUsersIfEmpty(String usersConfig) {
        if (credentialStore.countUsers() > 0) {
            return;
        }
        long nowMs = clock.millis();
        for (UserAccount account : parseUsers(usersConfig)) {
            credentialStore.createUserIfAbsent(new SecurityCredentialStore.UserRecord(
                    account.username(),
                    account.displayName(),
                    account.role(),
                    PasswordHasher.hash(account.password()),
                    true,
                    1L,
                    nowMs,
                    nowMs,
                    null,
                    nowMs
            ));
        }
    }

    private static List<UserAccount> parseUsers(String raw) {
        String source = (raw == null || raw.isBlank()) ? DEFAULT_USERS : raw;
        Map<String, UserAccount> map = new LinkedHashMap<>();
        for (String entry : source.split("[;,\r\n]+")) {
            String item = entry.trim();
            if (item.isEmpty()) continue;
            String[] parts = item.split(":", 4);
            if (parts.length < 3) {
                log.warn("忽略格式无效的认证用户配置项（需 username:password:role[:displayName]）");
                continue;
            }
            String username = parts[0].trim();
            String password = parts[1];
            String role = parts[2].trim().toUpperCase(Locale.ROOT);
            String displayName = parts.length >= 4 && !parts[3].trim().isEmpty() ? parts[3].trim() : username;
            if (username.isEmpty() || password.isEmpty() || !AuthContext.ALL_ROLES.contains(role)) {
                log.warn("忽略非法角色或空凭据的认证用户配置：username={}, role={}", username, role);
                continue;
            }
            map.put(username, new UserAccount(username, password, role, displayName));
        }
        return List.copyOf(map.values());
    }
}
