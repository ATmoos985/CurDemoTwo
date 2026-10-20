package com.example.cutdemotwo.algorithm;

import java.util.concurrent.CancellationException;

/** Cooperative stop point shared by search, geometry validation and toolpath computation. */
public final class ComputationCancellation {
    private ComputationCancellation() {}

    public static void check() {
        // Preserve the flag: the application layer owns final state and durable cleanup.
        if (Thread.currentThread().isInterrupted()) throw new CancellationException("计算收到停止请求");
    }
}
