package com.example.cutdemotwo.controller;

import com.example.cutdemotwo.service.RemnantRecommendationService;
import com.example.cutdemotwo.persistence.InventoryConflictException;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.HttpStatus;
import java.util.Map;

@RestController
@RequestMapping("/api/cutting")
public class RemnantRecommendationController {
    private final RemnantRecommendationService service;
    private final tools.jackson.databind.json.JsonMapper json = tools.jackson.databind.json.JsonMapper.builder()
            .enable(tools.jackson.databind.DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES,
                    tools.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .disable(tools.jackson.databind.DeserializationFeature.ACCEPT_FLOAT_AS_INT).build();
    public RemnantRecommendationController(RemnantRecommendationService service) { this.service = service; }

    @PostMapping(value = "/remnant-recommendations", consumes = "application/json")
    public RemnantRecommendationService.Analysis recommend(@RequestBody String body) {
        RemnantRecommendationService.Request request;
        try { request = json.readValue(body, RemnantRecommendationService.Request.class); }
        catch (RuntimeException invalid) { throw new IllegalArgumentException("推荐输入格式无效：请核对字段，需求编号和件数必须为整数"); }
        return service.recommend(request);
    }

    @ExceptionHandler(IllegalArgumentException.class) @ResponseStatus(HttpStatus.BAD_REQUEST)
    public Map<String, String> invalid(IllegalArgumentException e) { return Map.of("message", e.getMessage()); }
    @ExceptionHandler(InventoryConflictException.class) @ResponseStatus(HttpStatus.CONFLICT)
    public Map<String, String> conflict(InventoryConflictException e) { return Map.of("message", e.getMessage()); }
    @ExceptionHandler(RemnantRecommendationService.Busy.class) @ResponseStatus(HttpStatus.SERVICE_UNAVAILABLE)
    public Map<String, String> busy(RemnantRecommendationService.Busy e) { return Map.of("message", e.getMessage()); }
}
