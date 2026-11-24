package com.example.cutdemotwo.business.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.*;

/**
 * 车间领料 / 退料不可变单据：
 * 记录母卷发料到机台/班组（ISSUE）及从车间退回仓库（RETURN）的流转轨迹，过账后不可修改或删除。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record MaterialIssueDocument(
        String id,
        String idempotencyKey,
        String direction,
        String rollId,
        String materialModel,
        String batchNo,
        String machineId,
        String shiftTeam,
        String operator,
        String fromLocation,
        String toLocation,
        double remainingLengthMm,
        String reason,
        long postedAt,
        long inventoryRevision
) {
    public static final String DIRECTION_ISSUE = "ISSUE";
    public static final String DIRECTION_RETURN = "RETURN";

    public static void requireAppendOnly(
            Map<String, MaterialIssueDocument> previous,
            Map<String, MaterialIssueDocument> next
    ) {
        for (var entry : previous.entrySet()) {
            if (!Objects.equals(entry.getValue(), next.get(entry.getKey()))) {
                throw new IllegalStateException("已过账车间领退料单不可修改或删除；请新建单据冲正");
            }
        }
        var keys = new HashSet<String>();
        for (var entry : next.entrySet()) {
            if (!entry.getKey().equals(entry.getValue().id()) || !keys.add(entry.getValue().idempotencyKey())) {
                throw new IllegalStateException("车间领退料单编号或幂等身份重复");
            }
        }
    }
}
