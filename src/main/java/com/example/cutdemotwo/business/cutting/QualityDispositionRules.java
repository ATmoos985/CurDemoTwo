package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.business.model.QualityDisposition;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import java.util.Set;

/** Pure quality rules; inventory writes belong to the existing transactional aggregate. */
final class QualityDispositionRules {
    private QualityDispositionRules() {}

    static void validateCommand(QualityDisposition.Command command) {
        if (command == null || command.operationId() == null
                || !command.operationId().matches("[A-Za-z0-9_-]{16,80}") || command.expectedRevision() < 0)
            throw new IllegalArgumentException("请提供有效的复检操作编号和记录版本");
        if (!Set.of("REMNANT", "SCRAP").contains(String.valueOf(command.disposition())))
            throw new IllegalArgumentException("复检处置仅支持转料头或报废");
        if (command.reason() == null || command.reason().isBlank() || command.reason().length() > 500
                || command.inspector() == null || command.inspector().isBlank() || command.inspector().length() > 80)
            throw new IllegalArgumentException("请填写 1–500 字复检原因和 1–80 字检验人");
        if ("SCRAP".equals(command.disposition()) && command.recovery() != null)
            throw new IllegalArgumentException("报废处置不能同时登记料头");
        if ("REMNANT".equals(command.disposition()) && command.recovery() == null)
            throw new IllegalArgumentException("转料头需要实际回收区域、库位和质量状态");
    }

    static double recoveredArea(QualityDisposition.Command command, ReportOutput.ReportedPiece piece,
                                double minWidth, double minLength) {
        if (!Set.of("QUALIFIED", "REJECTED").contains(piece.outcome()))
            throw new IllegalArgumentException("未切裁片不能进行产出复检处置");
        if ("SCRAP".equals(command.disposition())) return 0;
        var recovery = command.recovery();
        for (double n : new double[]{recovery.x(), recovery.y(), recovery.width(), recovery.length()})
            if (!Double.isFinite(n)) throw new IllegalArgumentException("回收区域必须为有限毫米数值");
        if (recovery.x() < 0 || recovery.y() < 0 || recovery.width() <= 0 || recovery.length() <= 0
                || recovery.width() < minWidth || recovery.length() < minLength
                || recovery.x() + recovery.width() > piece.w() || recovery.y() + recovery.length() > piece.l())
            throw new IllegalArgumentException("回收区域超出裁片，或尺寸不足方案规定的最小回收尺寸");
        if (recovery.location() == null || recovery.location().isBlank() || recovery.location().length() > 100
                || !Set.of("RECOVERABLE", "QUARANTINED").contains(String.valueOf(recovery.quality())))
            throw new IllegalArgumentException("请填写库位，并明确回收区域已验收可用或待检隔离");
        var shape = piece.shape() == null ? NestingProblem.Shape.rectangle(piece.w(), piece.l()) : piece.shape();
        var outside = PolygonGeometry.region(NestingProblem.Shape.rectangle(recovery.width(), recovery.length()),
                recovery.x(), recovery.y());
        outside.subtract(PolygonGeometry.region(shape, 0, 0));
        if (!outside.isEmpty()) throw new IllegalArgumentException("实际回收矩形必须完全位于裁片轮廓内，不能使用异形外接框");
        return recovery.width() * recovery.length();
    }
}
