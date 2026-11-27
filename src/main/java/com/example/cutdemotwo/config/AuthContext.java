package com.example.cutdemotwo.config;

import java.util.List;
import java.util.Set;

/**
 * 请求级认证主体上下文（ThreadLocal）。
 * 由 {@link AuthSecurityFilter} 在进入过滤链前写入，并在 finally 中严格清理，避免线程复用串号。
 */
public final class AuthContext {
    public static final String ROLE_ADMIN = "ADMIN";
    public static final String ROLE_PLANNER = "PLANNER";
    public static final String ROLE_OPERATOR = "OPERATOR";
    public static final String ROLE_INSPECTOR = "INSPECTOR";
    public static final String ROLE_WAREHOUSE = "WAREHOUSE";
    public static final String ROLE_AGENT = "AGENT";

    public static final String ACTOR_USER = "USER";
    public static final String ACTOR_AGENT = "AGENT";

    public static final String SCOPE_DEMAND_READ = "DEMAND_READ";
    public static final String SCOPE_DEMAND_WRITE = "DEMAND_WRITE";
    public static final String SCOPE_INVENTORY_READ = "INVENTORY_READ";
    public static final String SCOPE_PLAN_COMPUTE = "PLAN_COMPUTE";
    public static final String SCOPE_DRAFT_WRITE = "DRAFT_WRITE";

    public static final Set<String> ALL_ROLES = Set.of(
            ROLE_ADMIN, ROLE_PLANNER, ROLE_OPERATOR, ROLE_INSPECTOR, ROLE_WAREHOUSE
    );

    public static final Set<String> AGENT_ALLOWED_SCOPES = Set.of(
            SCOPE_DEMAND_READ,
            SCOPE_DEMAND_WRITE,
            SCOPE_INVENTORY_READ,
            SCOPE_PLAN_COMPUTE,
            SCOPE_DRAFT_WRITE
    );

    public static final Principal LOCAL_PRINCIPAL = new Principal(
            "LOCAL", "本地免登模式", ROLE_ADMIN, List.of(ROLE_ADMIN), false,
            ACTOR_USER, null, List.of(), null, 0L
    );

    public static final Principal MES_INTEGRATION_PRINCIPAL = new Principal(
            "mes-integration", "MES 集成系统", ROLE_ADMIN, List.of(ROLE_ADMIN), true,
            ACTOR_USER, null, List.of(), null, 0L
    );

    public record Principal(
            String username,
            String displayName,
            String role,
            List<String> roles,
            boolean authenticated,
            String actorType,
            String agentId,
            List<String> scopes,
            String jti,
            long tokenVersion
    ) {
        public Principal(String username, String displayName, String role, List<String> roles, boolean authenticated) {
            this(username, displayName, role, roles, authenticated, ACTOR_USER, null, List.of(), null, 0L);
        }

        public Principal {
            roles = roles == null ? List.of() : List.copyOf(roles);
            actorType = (actorType == null || actorType.isBlank()) ? ACTOR_USER : actorType;
            scopes = scopes == null ? List.of() : List.copyOf(scopes);
        }

        public boolean isAgent() {
            return ACTOR_AGENT.equals(actorType);
        }
    }

    private static final ThreadLocal<Principal> HOLDER = new ThreadLocal<>();

    private AuthContext() {}

    public static void set(Principal principal) {
        if (principal == null) {
            HOLDER.remove();
        } else {
            HOLDER.set(principal);
        }
    }

    public static Principal current() {
        return HOLDER.get();
    }

    public static String username() {
        Principal principal = HOLDER.get();
        return principal == null ? null : principal.username();
    }

    public static String role() {
        Principal principal = HOLDER.get();
        return principal == null ? null : principal.role();
    }

    public static void clear() {
        HOLDER.remove();
    }
}
