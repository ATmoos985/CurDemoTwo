package com.example.cutdemotwo.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.slf4j.MDC;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

/** TraceIdFilter 单元测试：核验请求号生成、透传、日志注入防护与异常清理。 */
class TraceIdFilterTests {
    private final TraceIdFilter filter = new TraceIdFilter();

    @AfterEach
    void clearMdc() {
        MDC.clear();
    }

    @Test
    void generatesTraceIdSetsHeaderAndCleansMdc() throws Exception {
        var request = new MockHttpServletRequest("GET", "/api/health");
        var response = new MockHttpServletResponse();
        var observed = new AtomicReference<String>();

        FilterChain chain = (req, res) -> observed.set(MDC.get(TraceIdFilter.MDC_KEY));
        filter.doFilter(request, response, chain);

        String traceId = observed.get();
        assertNotNull(traceId);
        assertEquals(32, traceId.length());
        assertEquals(traceId, response.getHeader(TraceIdFilter.HEADER_NAME));
        assertNull(MDC.get(TraceIdFilter.MDC_KEY), "请求结束后必须清理 MDC");
    }

    @Test
    void preservesValidIncomingRequestId() throws Exception {
        var request = new MockHttpServletRequest("POST", "/api/v2/jobs");
        request.addHeader(TraceIdFilter.HEADER_NAME, "  req-2026.11:abc_01  ");
        var response = new MockHttpServletResponse();
        var observed = new AtomicReference<String>();

        filter.doFilter(request, response, (req, res) -> observed.set(MDC.get(TraceIdFilter.MDC_KEY)));

        assertEquals("req-2026.11:abc_01", observed.get());
        assertEquals("req-2026.11:abc_01", response.getHeader(TraceIdFilter.HEADER_NAME));
        assertNull(MDC.get(TraceIdFilter.MDC_KEY));
    }

    @Test
    void rejectsUnsafeOrOverlongRequestIdToPreventLogInjection() throws Exception {
        for (String unsafe : new String[]{"", "   ", "bad\r\ninjected", "has space", "a".repeat(65)}) {
            var request = new MockHttpServletRequest("GET", "/api/health");
            request.addHeader(TraceIdFilter.HEADER_NAME, unsafe);
            var response = new MockHttpServletResponse();
            var observed = new AtomicReference<String>();

            filter.doFilter(request, response, (req, res) -> observed.set(MDC.get(TraceIdFilter.MDC_KEY)));

            assertNotNull(observed.get());
            assertNotEquals(unsafe.trim(), observed.get());
            assertEquals(32, observed.get().length());
            assertEquals(observed.get(), response.getHeader(TraceIdFilter.HEADER_NAME));
            assertNull(MDC.get(TraceIdFilter.MDC_KEY));
        }
    }

    @Test
    void cleansMdcEvenWhenDownstreamThrows() {
        var request = new MockHttpServletRequest("GET", "/api/fail");
        request.addHeader(TraceIdFilter.HEADER_NAME, "err-trace-01");
        var response = new MockHttpServletResponse();

        assertThrows(ServletException.class, () -> filter.doFilter(request, response, (req, res) -> {
            assertEquals("err-trace-01", MDC.get(TraceIdFilter.MDC_KEY));
            throw new ServletException("模拟下游异常");
        }));

        assertEquals("err-trace-01", response.getHeader(TraceIdFilter.HEADER_NAME));
        assertNull(MDC.get(TraceIdFilter.MDC_KEY), "下游抛异常后仍须清理 MDC");
    }
}
