package com.example.cutdemotwo.controller;

import com.example.cutdemotwo.business.optimization.ComparisonQuestions;
import com.example.cutdemotwo.business.optimization.WorkbenchComparisonService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v2/workbench/tasks/{taskId}/comparison-questions")
public class ComparisonQuestionsController {
    public record Question(String leftId, String rightId, String question) {}

    private final WorkbenchComparisonService comparisons;
    private final ComparisonQuestions questions;

    public ComparisonQuestionsController(WorkbenchComparisonService comparisons, ComparisonQuestions questions) {
        this.comparisons = comparisons;
        this.questions = questions;
    }

    @PostMapping
    public ComparisonQuestions.Answer answer(@PathVariable String taskId, @RequestBody Question request,
                                             HttpServletRequest session) {
        if (request == null || request.question() == null || request.question().isBlank() || request.question().length() > 240)
            throw new IllegalArgumentException("请输入 1 至 240 个字符的问题。");
        if (request.leftId() == null || request.rightId() == null)
            throw new IllegalArgumentException("请选择两个归档结果。");
        var comparison = comparisons.compare(taskId, request.leftId(), request.rightId(), WorkbenchJobController.actor(session));
        return questions.answer(comparison, request.question().strip());
    }
}
