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

    public static final Set<String> ALL_ROLES = Set.of(
            ROLE_ADMIN, ROLE_PLANNER, ROLE_OPERATOR, ROLE_INSPECTOR, ROLE_WAREHOUSE
    );

    public static final Principal LOCAL_PRINCIPAL = new Principal(
            "LOCAL", "本地免登模式", ROLE_ADMIN, List.of(ROLE_ADMIN), false
    );

    public record Principal(
            String username,
            String displayName,
            String role,
            List<String> roles,
            boolean authenticated
    ) {
        public Principal {
            roles = roles == null ? List.of() : List.copyOf(roles);
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
