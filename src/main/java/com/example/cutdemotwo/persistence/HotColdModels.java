package com.example.cutdemotwo.persistence;

import com.example.cutdemotwo.business.model.CuttingPlan;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.ExecutionOrder;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.model.SchedulingScheme;

import java.util.List;
import java.util.Map;

/**
 * 热冷数据分离与按需分页查询专用只读值对象集合（属于 persistence 层契约，仅依赖 business.model）。
 */
public final class HotColdModels {
    private HotColdModels() {}

    /** 带 sort_order 的带序热态对象，确保按需回源或淘汰后重新加载时不破坏原有数据库行序。 */
    public record OrderedEntry<T>(String id, long sortOrder, T value) {}

    /**
     * 冷启动 / 跨节点刷新热池引导结果：
     * 严格只装载活跃库存、未完结任务、PENDING/活跃引用计划、活跃执行单与活跃排程方案，
     * 8 张历史只增表仅携带轻量计数与活跃材料盘点版本索引，零历史大对象常驻堆内存。
     */
    public record HotInventoryBootstrap(
            long revision,
            int remnantSeq,
            int defectSeq,
            long ledgerSize,
            long outboxSize,
            String outboxStreamHeadId,
            List<OrderedEntry<MotherRollInfo>> hotRolls,
            List<OrderedEntry<RemnantStock>> hotRemnants,
            List<OrderedEntry<CuttingTask>> hotTasks,
            List<OrderedEntry<CuttingPlan>> hotPlans,
            List<OrderedEntry<ExecutionOrder>> hotExecutions,
            List<OrderedEntry<SchedulingScheme>> hotSchemes,
            Map<String, Long> activeCountRevisions,
            long nextRollSortOrder,
            long nextRemnantSortOrder,
            long nextTaskSortOrder,
            long nextPlanSortOrder,
            long nextReceiptSortOrder,
            long nextExecutionSortOrder,
            long nextSchemeSortOrder
    ) {}

    /** 数据库级分页结果切片。 */
    public record PagedSlice<T>(
            List<T> items,
            long total,
            int limit,
            int offset,
            boolean hasMore
    ) {}
}
