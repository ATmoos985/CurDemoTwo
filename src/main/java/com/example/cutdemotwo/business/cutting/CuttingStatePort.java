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

    interface ReadView {
        long operationTime();

        List<DemandTemplate> listTemplates();

        List<SchedulingScheme> listSchemes();

        Optional<SchedulingScheme> findScheme(String id);

        Optional<SchedulingScheme> findSchemeByIdempotencyKey(String idempotencyKey);

        List<CuttingTask> listTasks();

        Optional<CuttingTask> findTask(String id);

        Optional<CuttingTask> findTaskByExternalRef(String externalRef);

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
    }

    interface WriteTx extends ReadView {
        void putTemplate(DemandTemplate template);

        boolean removeTemplate(String id);

        void putScheme(SchedulingScheme scheme);

        CuttingTask saveTask(CuttingTask input);

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
    }
}
