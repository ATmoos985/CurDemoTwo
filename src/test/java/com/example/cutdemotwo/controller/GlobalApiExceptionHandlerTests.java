package com.example.cutdemotwo.controller;

import com.example.cutdemotwo.config.TraceIdFilter;
import com.example.cutdemotwo.persistence.InventoryConflictException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.Map;

import static org.hamcrest.Matchers.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/**
 * 全局异常兜底处理器单元测试：
 * 核验统一 { code, message, traceId, retryable } 契约、traceId 透传、内部异常脱敏，
 * 以及不覆盖控制器自身局部 @ExceptionHandler 的优先级兼容性。
 */
class GlobalApiExceptionHandlerTests {
    private MockMvc mockMvc;

    @RestController
    @RequestMapping("/test-global")
    static class SampleController {
        record Payload(int count) {}

        @GetMapping("/illegal-arg")
        public void illegalArg() {
            throw new IllegalArgumentException("门幅必须为正数");
        }

        @GetMapping("/conflict")
        public void conflict() {
            throw new InventoryConflictException("库存版本已过期，请刷新");
        }

        @GetMapping("/illegal-state")
        public void illegalState() {
            throw new IllegalStateException("该母卷已报废");
        }

        @GetMapping("/response-status")
        public void responseStatus() {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "MES 访问令牌无效");
        }

        @GetMapping("/db-error")
        public void dbError() {
            throw new DataAccessResourceFailureException("SELECT * FROM secret_table WHERE password='xxx'");
        }

        @GetMapping("/unexpected")
        public void unexpected() {
            throw new RuntimeException("NullPointerException at C:\\internal\\secret.java:99");
        }

        @PostMapping(value = "/json", consumes = MediaType.APPLICATION_JSON_VALUE)
        public Payload parseJson(@RequestBody Payload payload) {
            return payload;
        }
    }

    @RestController
    @RequestMapping("/test-local")
    static class ControllerWithLocalHandler {
        @GetMapping("/bad")
        public void bad() {
            throw new IllegalArgumentException("局部异常应保持既有格式");
        }

        @ExceptionHandler(IllegalArgumentException.class)
        public ResponseEntity<Map<String, String>> localInvalid(IllegalArgumentException error) {
            return ResponseEntity.badRequest().body(Map.of("message", error.getMessage()));
        }
    }

    @BeforeEach
    void setup() {
        this.mockMvc = MockMvcBuilders.standaloneSetup(new SampleController(), new ControllerWithLocalHandler())
                .setControllerAdvice(new GlobalApiExceptionHandler())
                .addFilters(new TraceIdFilter())
                .build();
    }

    @Test
    void formatsStandardApiErrorsWithTraceId() throws Exception {
        mockMvc.perform(get("/test-global/illegal-arg").header(TraceIdFilter.HEADER_NAME, "trace-arg-001"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_INPUT"))
                .andExpect(jsonPath("$.message").value("门幅必须为正数"))
                .andExpect(jsonPath("$.traceId").value("trace-arg-001"))
                .andExpect(jsonPath("$.retryable").value(false));

        mockMvc.perform(get("/test-global/conflict").header(TraceIdFilter.HEADER_NAME, "trace-cnf-002"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("INVENTORY_CONFLICT"))
                .andExpect(jsonPath("$.message").value("库存版本已过期，请刷新"))
                .andExpect(jsonPath("$.traceId").value("trace-cnf-002"))
                .andExpect(jsonPath("$.retryable").value(false));

        mockMvc.perform(get("/test-global/illegal-state"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("INVALID_STATE"))
                .andExpect(jsonPath("$.traceId", not(emptyOrNullString())))
                .andExpect(jsonPath("$.retryable").value(false));

        mockMvc.perform(get("/test-global/response-status"))
                .andExpect(status().isUnauthorized())
                .andExpect(header().exists("WWW-Authenticate"))
                .andExpect(jsonPath("$.code").value("UNAUTHORIZED"))
                .andExpect(jsonPath("$.message").value("MES 访问令牌无效"))
                .andExpect(jsonPath("$.retryable").value(false));
    }

    @Test
    void handlesMalformedJsonAndMethodNotAllowed() throws Exception {
        mockMvc.perform(post("/test-global/json")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{bad json"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_INPUT"))
                .andExpect(jsonPath("$.traceId", not(emptyOrNullString())))
                .andExpect(jsonPath("$.retryable").value(false));

        mockMvc.perform(delete("/test-global/illegal-arg"))
                .andExpect(status().isMethodNotAllowed())
                .andExpect(jsonPath("$.code").value("METHOD_NOT_ALLOWED"))
                .andExpect(jsonPath("$.retryable").value(false));
    }

    @Test
    void sanitizesDatabaseAndUnexpectedExceptionsWithoutLeakingInternals() throws Exception {
        mockMvc.perform(get("/test-global/db-error").header(TraceIdFilter.HEADER_NAME, "trace-db-503"))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.code").value("STORAGE_UNAVAILABLE"))
                .andExpect(jsonPath("$.traceId").value("trace-db-503"))
                .andExpect(jsonPath("$.retryable").value(true))
                .andExpect(jsonPath("$.message", not(containsString("secret_table"))));

        mockMvc.perform(get("/test-global/unexpected").header(TraceIdFilter.HEADER_NAME, "trace-err-500"))
                .andExpect(status().isInternalServerError())
                .andExpect(jsonPath("$.code").value("INTERNAL_ERROR"))
                .andExpect(jsonPath("$.traceId").value("trace-err-500"))
                .andExpect(jsonPath("$.retryable").value(false))
                .andExpect(jsonPath("$.message", not(containsString("secret.java"))));
    }

    @Test
    void preservesExistingControllerLocalExceptionHandlerPrecedence() throws Exception {
        mockMvc.perform(get("/test-local/bad"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.message").value("局部异常应保持既有格式"))
                .andExpect(jsonPath("$.code").doesNotExist());
    }
}
