package com.example.cutdemotwo.business.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * 原子批量库存导入幂等凭证单据：
 * 记录母卷、料头或瑕疵批量导入的幂等键、规范化请求摘要哈希与回执摘要，
 * 过账后不可修改或删除，支持幂等重放与同键异载荷 409 冲突检测。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record InventoryBatchImportDocument(
        String id,
        String importType,
        String idempotencyKey,
        String requestHash,
        String operator,
        long postedAt,
        long inventoryRevision,
        Summary summary
) {
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Summary(
            String importType,
            boolean dryRun,
            boolean valid,
            String idempotencyKey,
            boolean idempotentReplay,
            String documentId,
            long revision,
            int totalRows,
            int validRows,
            int errorRows,
            int importedCount,
            int skippedCount,
            List<String> createdIds
    ) {
        public Summary {
            createdIds = createdIds == null ? List.of() : List.copyOf(createdIds);
        }

        public Summary asReplay() {
            return new Summary(
                    importType, dryRun, valid, idempotencyKey, true, documentId,
                    revision, totalRows, validRows, errorRows, importedCount, skippedCount,
                    new ArrayList<>(createdIds)
            );
        }
    }

    public static void requireAppendOnly(
            Map<String, InventoryBatchImportDocument> previous,
            Map<String, InventoryBatchImportDocument> next
    ) {
        for (var entry : previous.entrySet()) {
            if (!Objects.equals(entry.getValue(), next.get(entry.getKey()))) {
                throw new IllegalStateException("已过账批量导入单据不可修改或删除");
            }
        }
        var keys = new HashSet<String>();
        for (var entry : next.entrySet()) {
            if (!entry.getKey().equals(entry.getValue().id()) || !keys.add(entry.getValue().idempotencyKey())) {
                throw new IllegalStateException("批量导入单据编号或幂等身份重复");
            }
        }
    }
}
