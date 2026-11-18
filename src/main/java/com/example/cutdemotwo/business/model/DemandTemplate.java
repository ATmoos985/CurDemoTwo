package com.example.cutdemotwo.business.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;
import java.util.Map;

/**
 * 静态需求模板 / 纸样簇（BOM 配方库）：
 * 定义款式/套系组成部件、尺码档位及几何轮廓，供拼凑排程需求时按配码套数展开，本身不直接发生排程扣减。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record DemandTemplate(
        String id,
        String code,
        String name,
        String category,
        String dimension,
        String description,
        double defaultWidthMm,
        double defaultLengthMm,
        String materialModel,
        List<String> availableSizes,
        Map<String, Integer> defaultSizeCounts,
        boolean custom,
        List<PieceSpec> pieces,
        String updatedAt
) {
    public DemandTemplate {
        availableSizes = availableSizes == null ? List.of() : List.copyOf(availableSizes);
        defaultSizeCounts = defaultSizeCounts == null ? Map.of() : Map.copyOf(defaultSizeCounts);
        pieces = pieces == null ? List.of() : List.copyOf(pieces);
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PieceSpec(
            String name,
            String fabric,
            int quantityPerUnit,
            Boolean pairMirror,
            String grainRule,
            Map<String, SizeGeometry> sizes
    ) {
        public PieceSpec {
            sizes = sizes == null ? Map.of() : Map.copyOf(sizes);
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record SizeGeometry(
            double w,
            double h,
            List<List<Double>> v
    ) {
    }
}
