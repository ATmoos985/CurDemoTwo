package com.example.cutdemotwo.linear;

import changyang.cut.apsmodule.service.excel.ExcelImportService.OrderItem;
import changyang.cut.rest.dto.OptimizationRequest;
import java.util.List;

public record LinearCutRequest(int motherWidth, int leftTrim, int rightTrim, int minWidth,
        int maxWidth, int step, int totalOverCap, String profile, List<OrderItem> orderItems) {
    public OptimizationRequest toSolverRequest() {
        int available = motherWidth - leftTrim - rightTrim;
        require(motherWidth > 0 && motherWidth <= 100000 && leftTrim >= 0 && rightTrim >= 0
                && available > 0, "请检查母卷幅宽和左右切边（整数 mm）。");
        require(minWidth > 0 && maxWidth >= minWidth && maxWidth <= available && step > 0
                && (maxWidth - minWidth) / step <= 1000, "组合宽度必须位于扣除固定切边后的可切区内，候选宽度不能超过 1001 个。");
        require(totalOverCap >= 0 && totalOverCap <= 10000, "超产上限须在 0–10000 卷之间。");
        require("FAST".equals(profile) || "QUALITY".equals(profile), "请选择快速计算或精细优化。");
        require(orderItems != null && !orderItems.isEmpty() && orderItems.size() <= 500, "请提供 1–500 条需求。");
        for (OrderItem item : orderItems) {
            require(item != null && item.getWidth() > 0 && item.getWidth() <= maxWidth
                    && item.getQuantity() > 0 && item.getQuantity() <= 100000
                    && item.getLength() > 0 && item.getLength() <= 1000000,
                    "需求幅宽不能超过组合上限，需求卷数和卷长必须为正整数。");
            require(item.getMessageText() != null && !item.getMessageText().isBlank()
                    && item.getMessageText().length() <= 200 && item.getSurfaceTreatment() != null
                    && !item.getSurfaceTreatment().isBlank() && item.getSurfaceTreatment().length() <= 100,
                    "每条需求必须填写订单标识和表面处理。");
            item.setGroupKey(item.getLength() + "m+" + item.getSurfaceTreatment());
        }
        OptimizationRequest request = new OptimizationRequest();
        // 固定组合宽也走同一入口，保留物理母卷总宽作为整卷得率的分母。
        request.setFlexibleWidth(true);
        request.setTotalWidth(motherWidth);
        request.setMinWidth(minWidth);
        request.setMaxWidth(maxWidth);
        request.setStepSize(step);
        request.setTotalOverCap(totalOverCap);
        request.setUseNewSolver(true);
        request.setSolverProfile(OptimizationRequest.SolverProfile.valueOf(profile));
        request.setOrderItems(orderItems);
        return request;
    }

    private static void require(boolean valid, String message) {
        if (!valid) throw new IllegalArgumentException(message);
    }
}
