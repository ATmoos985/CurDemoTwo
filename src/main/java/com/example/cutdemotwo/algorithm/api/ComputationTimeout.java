package com.example.cutdemotwo.algorithm.api;

/** 算法已停止后的时限异常；调度方不依赖具体引擎异常类型。 */
public final class ComputationTimeout extends RuntimeException {
    public ComputationTimeout() { super("一维计算达到时限；计算进程已退出"); }
}
