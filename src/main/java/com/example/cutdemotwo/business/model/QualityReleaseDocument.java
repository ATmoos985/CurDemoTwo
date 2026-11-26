package com.example.cutdemotwo.business.model;

import java.util.*;

/**
 * 隔离料头质量复验放行/报废不可变单据：
 * 仅作用于 QUARANTINED 状态料头，放行转为 AVAILABLE 或判废转为 SCRAPPED，过账后不可修改或删除。
 */
public record QualityReleaseDocument(
        String id,
        String idempotencyKey,
        String remnantId,
        String decision,
        String fromStatus,
        String toStatus,
        String inspector,
        String reason,
        long postedAt,
        long inventoryRevision
) {
    public static final String DECISION_RELEASE_AVAILABLE = "RELEASE_AVAILABLE";
    public static final String DECISION_SCRAP = "SCRAP";

    public static void requireAppendOnly(
            Map<String, QualityReleaseDocument> previous,
            Map<String, QualityReleaseDocument> next
    ) {
        for (var entry : previous.entrySet()) {
            if (!Objects.equals(entry.getValue(), next.get(entry.getKey()))) {
                throw new IllegalStateException("已过账质量复验放行单不可修改或删除；请新建单据追溯");
            }
        }
        var keys = new HashSet<String>();
        for (var entry : next.entrySet()) {
            if (!entry.getKey().equals(entry.getValue().id()) || !keys.add(entry.getValue().idempotencyKey())) {
                throw new IllegalStateException("质量复验放行单编号或幂等身份重复");
            }
        }
    }
}
