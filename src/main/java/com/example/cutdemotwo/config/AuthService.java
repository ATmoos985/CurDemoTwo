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

/**
 * 轻量企业认证与 HMAC-SHA256 令牌服务：
 * <ul>
 *   <li>默认 {@code cutdemo.auth.enabled=false}，保持单机与自动化测试完全免登兼容；</li>
 *   <li>内置可配置 5 角色工厂账户（ADMIN / PLANNER / OPERATOR / INSPECTOR / WAREHOUSE）；</li>
 *   <li>签发无状态 HS256 JWT 风格令牌，常量时间比对签名与口令，防伪造与时序泄露。</li>
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
            List<String> roles
    ) {}

    private final boolean enabled;
    private final byte[] secretBytes;
    private final long tokenTtlSeconds;
    private final Map<String, UserAccount> users;
    private final Clock clock;

    @Autowired
    public AuthService(
            @Value("${cutdemo.auth.enabled:false}") boolean enabled,
            @Value("${cutdemo.auth.secret:}") String secret,
            @Value("${cutdemo.auth.users:}") String usersConfig,
            @Value("${cutdemo.auth.token-ttl-hours:12}") long tokenTtlHours
    ) {
        this(enabled, secret, usersConfig, tokenTtlHours, Clock.systemUTC());
    }

    public AuthService(boolean enabled, String secret, String usersConfig, long tokenTtlHours, Clock clock) {
        this.enabled = enabled;
        this.clock = clock == null ? Clock.systemUTC() : clock;
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
        this.users = parseUsers(usersConfig);
    }

    public boolean isEnabled() {
        return enabled;
    }

    public Optional<LoginResult> authenticate(String username, String password) {
        if (username == null || username.isBlank() || password == null || password.isEmpty()) {
            return Optional.empty();
        }
        UserAccount account = users.get(username.trim());
        if (account == null) {
            return Optional.empty();
        }
        boolean matched = MessageDigest.isEqual(
                account.password().getBytes(StandardCharsets.UTF_8),
                password.getBytes(StandardCharsets.UTF_8)
        );
        if (!matched) {
            return Optional.empty();
        }
        Instant now = clock.instant();
        Instant expiresAt = now.plusSeconds(tokenTtlSeconds);
        String token = signToken(account, now.getEpochSecond(), expiresAt.getEpochSecond());
        return Optional.of(new LoginResult(
                token,
                account.username(),
                account.displayName(),
                account.role(),
                expiresAt.toString()
        ));
    }

    public Optional<AuthContext.Principal> verifyToken(String rawToken) {
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
            String role = payload.path("role").asString("").toUpperCase(Locale.ROOT);
            String name = payload.path("name").asString(sub);
            long exp = payload.path("exp").asLong(0L);
            if (sub.isBlank() || !AuthContext.ALL_ROLES.contains(role)) {
                return Optional.empty();
            }
            if (exp <= clock.instant().getEpochSecond()) {
                return Optional.empty();
            }
            return Optional.of(new AuthContext.Principal(sub, name, role, List.of(role), true));
        } catch (RuntimeException invalidPayload) {
            return Optional.empty();
        }
    }

    public Optional<AuthContext.Principal> verifyAuthorizationHeader(String authorizationHeader) {
        return extractBearerToken(authorizationHeader).flatMap(this::verifyToken);
    }

    public MeResponse me(String authorizationHeader) {
        if (!enabled) {
            return new MeResponse(false, false, "LOCAL", "本地免登模式", AuthContext.ROLE_ADMIN, List.of(AuthContext.ROLE_ADMIN));
        }
        Optional<AuthContext.Principal> principal = verifyAuthorizationHeader(authorizationHeader);
        if (principal.isPresent()) {
            AuthContext.Principal p = principal.get();
            return new MeResponse(true, true, p.username(), p.displayName(), p.role(), p.roles());
        }
        return new MeResponse(true, false, "", "", "", List.of());
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

    private String signToken(UserAccount account, long issuedAtEpochSec, long expiresAtEpochSec) {
        Map<String, Object> claims = new LinkedHashMap<>();
        claims.put("sub", account.username());
        claims.put("name", account.displayName());
        claims.put("role", account.role());
        claims.put("iat", issuedAtEpochSec);
        claims.put("exp", expiresAtEpochSec);
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

    private static Map<String, UserAccount> parseUsers(String raw) {
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
        return Map.copyOf(map);
    }
}
