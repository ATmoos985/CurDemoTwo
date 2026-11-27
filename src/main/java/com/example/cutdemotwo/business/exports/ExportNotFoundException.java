package com.example.cutdemotwo.business.exports;

/**
 * 导出目标资源（排程方案、任务等）不存在异常，由控制器统一映射为 HTTP 404。
 */
public class ExportNotFoundException extends RuntimeException {
    public ExportNotFoundException(String message) {
        super(message);
    }
}
