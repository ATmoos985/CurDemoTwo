package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.business.model.CutReport;
import com.example.cutdemotwo.business.model.CuttingPlan;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.DemandTemplate;
import com.example.cutdemotwo.business.model.ExecutionOrder;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.business.model.SolveRequest;
import com.example.cutdemotwo.business.model.SolveResponse;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.Function;

/**
 * 裁切领域受控状态与事务端口：
 * 为排程工作室与查询协作者提供有界事务内的只读视图与受控写操作，
 * 隔离底层内存聚合存储结构，禁止暴露内部可变 Map 或序列化器引用。
 */
interface CuttingStatePort {

    <T> T inRead(Function<ReadView, T> query);

    <T> T inWrite(String eventType, String businessId, String actor, Function<WriteTx, T> command);

    /**
     * 带原子幂等重放检查的写事务：在锁内 refresh 后先执行 replay，若返回非空则直接返回且不触发持久化或升版本。
     */
    default <T> T inWrite(
            String eventType,
            String businessId,
            String actor,
            Function<ReadView, T> replay,
            Function<WriteTx, T> command
    ) {
        return inWrite(eventType, businessId, actor, tx -> {
            T hit = replay.apply(tx);
            return hit != null ? hit : command.apply(tx);
        });
    }

    /**
     * 需求模板独立读写端口：与库存台账、账本及全局 revision 解耦，避免模板编辑与车间库存写入互斥。
     */
    List<DemandTemplate> listTemplatesIndependent();

    DemandTemplate saveTemplateIndependent(DemandTemplate template);

    boolean deleteTemplateIndependent(String id);

    interface ReadView {
        long operationTime();

        long currentRevision();

        List<DemandTemplate> listTemplates();

        List<SchedulingScheme> listSchemes();

        Optional<SchedulingScheme> findScheme(String id);

        Optional<SchedulingScheme> findSchemeByIdempotencyKey(String idempotencyKey);

        Optional<SchedulingScheme> findSchemeByMesReceiptNo(String mesReceiptNo);

        List<CuttingTask> listTasks();

        Optional<CuttingTask> findTask(String id);

        Optional<CuttingTask> findTaskByExternalRef(String externalRef);

        Optional<CuttingTask> findTaskByReplenishIdempotencyKey(String idempotencyKey);

        /** 校验目标母卷或料头的缸号/色号是否满足任务的防色差约束（不匹配抛 IllegalArgumentException）。 */
        void validateBatchAndColorForTask(CuttingTask task, MotherRollInfo roll, RemnantStock remnant);

        List<CuttingPlan> listPlans();

        Optional<CuttingPlan> findPlan(String id);

        List<ExecutionOrder> listExecutions();

        Optional<MotherRollInfo> findRoll(String id);

        Optional<RemnantStock> findRemnant(String id);

        List<RemnantStock> listRemnantsBySourceRoll(String rollId);

        Optional<Map<String, Object>> findReceipt(String planId);

        List<Map<String, Object>> listReceipts();

        Map<String, Integer> completedQuantities(String taskId);

        Map<String, Object> projectQuality(Map<String, Object> receipt);

        /** 检查指定物理材料是否被有效执行单预约或正在加工。 */
        boolean isMaterialReservedByExecution(String materialType, String materialId, String exceptPlanId);
    }

    interface WriteTx extends ReadView {
        void putTemplate(DemandTemplate template);

        boolean removeTemplate(String id);

        void putScheme(SchedulingScheme scheme);

        CuttingTask saveTask(CuttingTask input);

        /** 排程方案内部受控更新任务（如绑卷对齐型号或同款补片加量），忽略当前正在操作的方案自身预约。 */
        CuttingTask saveTaskForScheme(CuttingTask input, String exceptSchemeId);

        MotherRollInfo saveRoll(MotherRollInfo roll);

        void prepareTaskSolve(SolveRequest request);

        /**
         * 在事务内生成计划编号、计算材料指纹、深拷贝隔离并落库为 PENDING 状态计划。
         */
        String savePendingPlan(SolveRequest request, SolveResponse validated);

        /**
         * 校验该计划不存在有效实切报工记录，并将 PENDING 状态计划置为 CANCELLED。
         */
        void cancelPendingPlan(String planId);

        Map<String, Object> confirmPlan(CutReport report, Set<String> pendingBatchPlans);

        /**
         * 跨任务合排报工过账：同时在回执写入各源任务合格量映射与逐件归属映射，保证完工结转、判废与冲销全链路可追溯。
         */
        Map<String, Object> confirmPlan(
                CutReport report,
                Set<String> pendingBatchPlans,
                Map<String, Map<String, Integer>> taskDemandQuantities,
                Map<Integer, SchedulingScheme.TaskDemandAllocation> pieceSources
        );
    }
}
