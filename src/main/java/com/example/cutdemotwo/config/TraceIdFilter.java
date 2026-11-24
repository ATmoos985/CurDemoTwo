package com.example.cutdemotwo.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * 全链路请求标识过滤器：为每个 HTTP 请求透传或生成 X-Request-Id，
 * 写入 SLF4J MDC（traceId）与响应头，并在请求结束时严格清理，避免线程复用串号。
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class TraceIdFilter extends OncePerRequestFilter {
    public static final String HEADER_NAME = "X-Request-Id";
    public static final String MDC_KEY = "traceId";
    private static final int MAX_ID_LENGTH = 64;
    private static final Pattern SAFE_ID_PATTERN = Pattern.compile("^[A-Za-z0-9._:-]+$");

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        String traceId = resolveTraceId(request.getHeader(HEADER_NAME));
        MDC.put(MDC_KEY, traceId);
        response.setHeader(HEADER_NAME, traceId);
        try {
            filterChain.doFilter(request, response);
        } finally {
            MDC.remove(MDC_KEY);
        }
    }

    static String resolveTraceId(String incoming) {
        if (incoming != null) {
            String trimmed = incoming.trim();
            if (!trimmed.isEmpty()
                    && trimmed.length() <= MAX_ID_LENGTH
                    && SAFE_ID_PATTERN.matcher(trimmed).matches()) {
                return trimmed;
            }
        }
        return UUID.randomUUID().toString().replace("-", "");
    }
}
