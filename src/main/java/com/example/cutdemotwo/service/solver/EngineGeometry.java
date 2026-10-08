package com.example.cutdemotwo.service.solver;

import com.example.cutdemotwo.model.Defect;
import com.example.cutdemotwo.model.nesting.NestingProblem;
import java.util.List;

public final class EngineGeometry {
    public static final double COORDINATE_EPS_MM = .001;

    private EngineGeometry() {}

    /** Normalize boundary roundoff without clamping genuinely out-of-bounds coordinates. */
    public static double normalizeZero(double coordinate) {
        return Math.abs(coordinate) <= COORDINATE_EPS_MM ? 0.0 : coordinate;
    }

    public static List<Defect> defects(NestingProblem problem) {
        return problem.material().exclusions().stream().map(d -> new Defect(d.id(), d.x(), d.y(),
                d.shape().width(), d.shape().height(), d.clearance())).toList();
    }
}
