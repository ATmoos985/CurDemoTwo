package com.example.cutdemotwo.algorithm.nesting.constraints;

import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingResult;

import java.util.List;

/**
 * 阶段 4：独立终检校验（与求解器隔离，对最终 placements/leftovers 逐条验真）。
 * 违规时抛出 {@link IllegalArgumentException}，携带清晰中文违规原因。
 */
@FunctionalInterface
public interface ResultConstraintVerifier {
    void verify(NestingProblem problem,
                List<NestingResult.Placement> placements,
                List<NestingResult.Leftover> leftovers);
}
