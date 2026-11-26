package com.example.cutdemotwo.business.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.*;

/**
 * 采购批量入库不可变单据：
 * 整批原子创建多卷母卷（默认待检 PENDING，允许显式传 PASSED 并登记检验员），过账后不可修改或删除。
 */
public record InventoryReceiptDocument(
        String id,
        String idempotencyKey,
        String supplierName,
        String deliveryNoteNo,
        String operator,
        String remarks,
        long postedAt,
        long inventoryRevision,
        List<Line> lines
) {
    public InventoryReceiptDocument {
        lines = lines == null ? List.of() : List.copyOf(lines);
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Line(
            String rollId,
            String materialModel,
            String materialType,
            String color,
            String batchNo,
            double widthMm,
            double totalLengthMm,
            double grammage,
            double shrinkageRate,
            String storageLocation,
            String inspectionStatus,
            String inspector
    ) {}

    public static void requireAppendOnly(
            Map<String, InventoryReceiptDocument> previous,
            Map<String, InventoryReceiptDocument> next
    ) {
        for (var entry : previous.entrySet()) {
            if (!Objects.equals(entry.getValue(), next.get(entry.getKey()))) {
                throw new IllegalStateException("已过账采购入库单不可修改或删除；请新建单据更正");
            }
        }
        var keys = new HashSet<String>();
        for (var entry : next.entrySet()) {
            if (!entry.getKey().equals(entry.getValue().id()) || !keys.add(entry.getValue().idempotencyKey())) {
                throw new IllegalStateException("采购入库单编号或幂等身份重复");
            }
        }
    }
}
