package com.example.cutdemotwo.contracts.jobs;

/** 一维、二维共用的输入/能力检查结果；字段保持现有 HTTP 契约。 */
public record ProblemCheck(String status, String message, String requestedEngine, String engine, String fallbackReason) {}
