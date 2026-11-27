package com.example.cutdemotwo.business.cutting;

import java.util.List;

/**
 * 原子批量库存导入整批校验异常：
 * 在写事务内任意行校验失败时抛出，触发 {@link InventoryStateKernel} 与 JDBC 单事务全量回滚，
 * 并向 HTTP 层携带全量逐行结构化错误明细。
 */
public class BatchImportValidationException extends RuntimeException {
    private final String importType;
    private final List<RowError> errors;

    public record RowError(int rowIndex, String field, String code, String message) {}

    public BatchImportValidationException(String importType, String message, List<RowError> errors) {
        super(message);
        this.importType = importType;
        this.errors = errors == null ? List.of() : List.copyOf(errors);
    }

    public String getImportType() {
        return importType;
    }

    public List<RowError> getErrors() {
        return errors;
    }
}
