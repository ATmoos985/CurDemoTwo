package com.example.cutdemotwo.controller;

import com.example.cutdemotwo.config.AuthSecurityFilter;
import com.example.cutdemotwo.config.TraceIdFilter;
import com.example.cutdemotwo.contracts.jobs.OptimizationFailure;
import com.example.cutdemotwo.persistence.InventoryConflictException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MissingRequestHeaderException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.ServletRequestBindingException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import java.util.UUID;

/**
 * 全局 REST 异常兜底处理器：
 * 统一输出 {@code { code, message, traceId, retryable }} 契约，并在兜底路径自动脱敏，
 * 同时保持低于控制器内部局部 {@code @ExceptionHandler} 的优先级，不破坏存量契约断言。
 */
@RestControllerAdvice
@Order(Ordered.LOWEST_PRECEDENCE)
public class GlobalApiExceptionHandler {
    private static final Logger log = LoggerFactory.getLogger(GlobalApiExceptionHandler.class);

    public record ApiError(String code, String message, String traceId, boolean retryable) {}

    @ExceptionHandler(OptimizationFailure.class)
    public ResponseEntity<ApiError> handleOptimizationFailure(OptimizationFailure error) {
        String code = hasText(error.code) ? error.code : mapStatusCode(error.status);
        String message = hasText(error.getMessage()) ? error.getMessage() : defaultMessageForStatus(error.status);
        var builder = ResponseEntity.status(error.status);
        if (error.retryable) {
            builder.header("Retry-After", "1");
        }
        return builder.body(new ApiError(code, message, currentTraceId(), error.retryable));
    }

    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<ApiError> handleResponseStatus(ResponseStatusException error) {
        HttpStatusCode status = error.getStatusCode();
        int codeValue = status.value();
        String code = mapStatusCode(codeValue);
        String message = (error.getReason() != null && !error.getReason().isBlank())
                ? error.getReason()
                : defaultMessageForStatus(codeValue);
        boolean retryable = codeValue == 429 || codeValue == 503;
        var builder = ResponseEntity.status(status);
        if (codeValue == 401) {
            builder.header("WWW-Authenticate", "Bearer realm=\"cutdemo\"");
        }
        return builder.body(new ApiError(code, message, currentTraceId(), retryable));
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<ApiError> handleIllegalArgument(IllegalArgumentException error) {
        String message = hasText(error.getMessage()) ? error.getMessage() : "请求参数无效";
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                .body(new ApiError("INVALID_INPUT", message, currentTraceId(), false));
    }

    @ExceptionHandler(InventoryConflictException.class)
    public ResponseEntity<ApiError> handleInventoryConflict(InventoryConflictException error) {
        String message = hasText(error.getMessage()) ? error.getMessage() : "库存或单据版本发生冲突，请刷新后重试";
        return ResponseEntity.status(HttpStatus.CONFLICT)
                .body(new ApiError("INVENTORY_CONFLICT", message, currentTraceId(), false));
    }

    @ExceptionHandler(IllegalStateException.class)
    public ResponseEntity<ApiError> handleIllegalState(IllegalStateException error) {
        String message = hasText(error.getMessage()) ? error.getMessage() : "当前状态不允许执行此操作";
        return ResponseEntity.status(HttpStatus.CONFLICT)
                .body(new ApiError("INVALID_STATE", message, currentTraceId(), false));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<ApiError> handleUnreadableBody(HttpMessageNotReadableException error) {
        if (AuthSecurityFilter.containsPayloadTooLarge(error)) {
            return ResponseEntity.status(HttpStatus.PAYLOAD_TOO_LARGE)
                    .body(new ApiError("PAYLOAD_TOO_LARGE", "请求正文超过服务端限制", currentTraceId(), false));
        }
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                .body(new ApiError("INVALID_INPUT", "请求 JSON 格式错误或缺少合法请求正文", currentTraceId(), false));
    }

    @ExceptionHandler({
            MethodArgumentTypeMismatchException.class,
            MissingServletRequestParameterException.class,
            MissingRequestHeaderException.class,
            ServletRequestBindingException.class
    })
    public ResponseEntity<ApiError> handleBadBinding(Exception error) {
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                .body(new ApiError("INVALID_INPUT", "请求参数缺失或格式无效", currentTraceId(), false));
    }

    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    public ResponseEntity<ApiError> handleMethodNotAllowed(HttpRequestMethodNotSupportedException error) {
        return ResponseEntity.status(HttpStatus.METHOD_NOT_ALLOWED)
                .body(new ApiError("METHOD_NOT_ALLOWED", "不支持的 HTTP 请求方法", currentTraceId(), false));
    }

    @ExceptionHandler(HttpMediaTypeNotSupportedException.class)
    public ResponseEntity<ApiError> handleUnsupportedMediaType(HttpMediaTypeNotSupportedException error) {
        return ResponseEntity.status(HttpStatus.UNSUPPORTED_MEDIA_TYPE)
                .body(new ApiError("UNSUPPORTED_MEDIA_TYPE", "不支持的请求内容类型（Content-Type）", currentTraceId(), false));
    }

    @ExceptionHandler(NoResourceFoundException.class)
    public ResponseEntity<ApiError> handleNoResource(NoResourceFoundException error) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND)
                .body(new ApiError("NOT_FOUND", "请求的接口或资源不存在", currentTraceId(), false));
    }

    @ExceptionHandler(MaxUploadSizeExceededException.class)
    public ResponseEntity<ApiError> handleMaxUploadSize(MaxUploadSizeExceededException error) {
        return ResponseEntity.status(HttpStatus.PAYLOAD_TOO_LARGE)
                .body(new ApiError("PAYLOAD_TOO_LARGE", "上传内容超过大小限制", currentTraceId(), false));
    }

    @ExceptionHandler(DataAccessException.class)
    public ResponseEntity<ApiError> handleDataAccess(DataAccessException error) {
        String traceId = currentTraceId();
        log.error("数据库持久化操作异常, traceId={}", traceId, error);
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                .body(new ApiError("STORAGE_UNAVAILABLE", "存储服务暂不可用，请保留原幂等键稍后重试（traceId=" + traceId + "）", traceId, true));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiError> handleUnexpected(Exception error) {
        if (AuthSecurityFilter.containsPayloadTooLarge(error)) {
            return ResponseEntity.status(HttpStatus.PAYLOAD_TOO_LARGE)
                    .body(new ApiError("PAYLOAD_TOO_LARGE", "请求正文超过服务端限制", currentTraceId(), false));
        }
        String traceId = currentTraceId();
        log.error("未捕获的服务端异常, traceId={}", traceId, error);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(new ApiError("INTERNAL_ERROR", "服务器内部异常，请凭 traceId 联系管理员排查", traceId, false));
    }

    private static String currentTraceId() {
        String traceId = MDC.get(TraceIdFilter.MDC_KEY);
        if (traceId != null && !traceId.isBlank()) {
            return traceId;
        }
        return UUID.randomUUID().toString().replace("-", "");
    }

    private static boolean hasText(String value) {
        return value != null && !value.isBlank();
    }

    private static String mapStatusCode(int status) {
        return switch (status) {
            case 400 -> "INVALID_INPUT";
            case 401 -> "UNAUTHORIZED";
            case 403 -> "FORBIDDEN";
            case 404 -> "NOT_FOUND";
            case 405 -> "METHOD_NOT_ALLOWED";
            case 409 -> "CONFLICT";
            case 413 -> "PAYLOAD_TOO_LARGE";
            case 415 -> "UNSUPPORTED_MEDIA_TYPE";
            case 422 -> "UNSUPPORTED_CONSTRAINT";
            case 429 -> "RATE_LIMIT_EXCEEDED";
            case 503 -> "SERVICE_UNAVAILABLE";
            default -> status >= 500 ? "INTERNAL_ERROR" : "REQUEST_FAILED";
        };
    }

    private static String defaultMessageForStatus(int status) {
        return switch (status) {
            case 401 -> "未登录或访问令牌无效";
            case 403 -> "无权执行当前操作";
            case 404 -> "请求的资源不存在";
            case 503 -> "服务暂不可用，请稍后重试";
            default -> "请求处理失败";
        };
    }
}
