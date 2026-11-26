package com.example.cutdemotwo.algorithm.geometry;

import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import java.util.List;
import java.util.Locale;

public final class EngineGeometry {
    public static final double COORDINATE_EPS_MM = .001;
    public static final double AREA_EPS_MM2 = .001;
    public static final String DEFAULT_GUILLOTINE_START_CORNER = "right-top";

    private EngineGeometry() {}

    /** Normalize boundary roundoff without clamping genuinely out-of-bounds coordinates. */
    public static double normalizeZero(double coordinate) {
        return Math.abs(coordinate) <= COORDINATE_EPS_MM ? 0.0 : coordinate;
    }

    /** Resolve startCorner with a unified default across native and pure-Java guillotine engines. */
    public static String normalizeStartCorner(String startCorner) {
        if (startCorner == null || startCorner.isBlank()) {
            return DEFAULT_GUILLOTINE_START_CORNER;
        }
        return startCorner.trim().toLowerCase(Locale.ROOT);
    }

    public static List<Defect> defects(NestingProblem problem) {
        return problem.material().exclusions().stream().map(d -> new Defect(d.id(), d.x(), d.y(),
                d.shape().width(), d.shape().height(), d.clearance())).toList();
    }
}
