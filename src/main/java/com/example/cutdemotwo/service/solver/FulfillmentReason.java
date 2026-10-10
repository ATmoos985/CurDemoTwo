package com.example.cutdemotwo.service.solver;

import com.example.cutdemotwo.model.nesting.NestingProblem;

/** Only deterministic dimension checks explain impossibility; search omissions remain undecided. */
final class FulfillmentReason {
    private FulfillmentReason() {}
    static String unplaced(NestingProblem problem, NestingProblem.Part part, boolean manual) {
        if (manual) return "NOT_INCLUDED_IN_MANUAL_LAYOUT";
        if (!"RECTANGLE".equals(problem.material().shape().type()) || !"RECTANGLE".equals(part.shape().type())
                || "CONTOUR".equals(problem.process().mode())) return "NOT_PLACED_IN_THIS_SOLUTION";
        double w = part.shape().width(), h = part.shape().height();
        double width = problem.width(), height = problem.height() - problem.process().trimStart();
        boolean direct = w <= width + .001 && h <= height + .001;
        boolean rotated = h <= width + .001 && w <= height + .001;
        boolean rotationAllowed = part.allowRotation() && !"CROSSCUT".equals(problem.process().mode());
        if (direct || (rotationAllowed && rotated)) return "NOT_PLACED_IN_THIS_SOLUTION";
        if (rotated && !rotationAllowed && !"CROSSCUT".equals(problem.process().mode())) return "ROTATION_REQUIRED";
        if (w > width + .001 && (!rotationAllowed || h > width + .001)) return "EXCEEDS_MATERIAL_WIDTH";
        if (h > height + .001 && (!rotationAllowed || w > height + .001)) return "EXCEEDS_PROCESSING_LENGTH";
        return "EXCEEDS_PROCESSING_REGION";
    }
}
