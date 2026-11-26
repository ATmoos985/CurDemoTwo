package com.example.cutdemotwo.contracts.jobs;

/**
 * 标准计算作业共享异常契约：供持久层与业务层共同抛出结构化作业错误，
 * 彻底解除 persistence 对 business.optimization 的反向依赖。
 */
public class OptimizationFailure extends RuntimeException {
    public final String code;
    public final int status;
    public final boolean retryable;

    public OptimizationFailure(String code, String message, int status, boolean retryable) {
        super(message);
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}
