package com.example.cutdemotwo.service.solver;

import com.example.cutdemotwo.model.Defect;
import com.example.cutdemotwo.model.nesting.NestingProblem;
import java.util.List;

public final class EngineGeometry {
    private EngineGeometry() {}
    public static List<Defect> defects(NestingProblem problem) {
        return problem.material().exclusions().stream().map(d -> new Defect(d.id(), d.x(), d.y(),
                d.shape().width(), d.shape().height(), d.clearance())).toList();
    }
}
