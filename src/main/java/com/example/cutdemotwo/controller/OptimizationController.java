package com.example.cutdemotwo.controller;

import com.example.cutdemotwo.business.optimization.OptimizationService;
import com.example.cutdemotwo.contracts.jobs.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.ResponseEntity;
import tools.jackson.databind.*;
import tools.jackson.databind.json.JsonMapper;
import java.io.*;
import java.net.URI;
import java.util.*;

@RestController
@RequestMapping("/api/v2")
public class OptimizationController {
    private final OptimizationService jobs;
    private final JsonMapper json=JsonMapper.builder().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES,
            DeserializationFeature.FAIL_ON_TRAILING_TOKENS,DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES)
            .enable(tools.jackson.core.StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT).disable(MapperFeature.ALLOW_COERCION_OF_SCALARS).build();
    public OptimizationController(OptimizationService jobs){this.jobs=jobs;}
    @GetMapping("/capabilities") public Object capabilities(){return jobs.capabilities();}
    @PostMapping(value="/problem-validations",consumes="application/json") public Object validate(InputStream input){return jobs.validate(decode(input));}
    @PostMapping(value="/optimization-jobs",consumes="application/json")
    public ResponseEntity<OptimizationJob> submit(@RequestHeader(value="Idempotency-Key",required=false) String key,InputStream input){
        var job=jobs.submit(key,decode(input));
        return ResponseEntity.accepted().location(URI.create("/api/v2/optimization-jobs/"+job.id())).header("Retry-After","1").body(job);
    }
    @GetMapping("/optimization-jobs/{id}") public OptimizationJob job(@PathVariable String id){return jobs.get(id);}
    @GetMapping("/optimization-jobs/{id}/input") public OptimizationRequest input(@PathVariable String id){return jobs.input(id);}
    @GetMapping("/optimization-results/{id}") public OptimizationResult result(@PathVariable String id){return jobs.result(id);}
    @GetMapping("/result-comparisons") public ResultComparison compare(@RequestParam(defaultValue="") String leftId,@RequestParam(defaultValue="") String rightId){return jobs.compare(leftId,rightId);}
    @PostMapping("/optimization-jobs/{id}/cancellations") public OptimizationJob cancel(@PathVariable String id){return jobs.cancel(id);}
    private OptimizationRequest decode(InputStream input){
        try {
            byte[] bytes=input.readNBytes(262145);
            if(bytes.length>262144)throw new OptimizationService.Failure("PAYLOAD_TOO_LARGE","请求正文最多 262144 字节",413,false);
            return json.readValue(bytes,OptimizationRequest.class);
        } catch(OptimizationService.Failure error){throw error;}
        catch(IOException | RuntimeException error){throw new OptimizationService.Failure("INVALID_INPUT","JSON 格式、字段或类型错误；请核对 v2 作业契约",400,false);}
    }
    @ExceptionHandler(OptimizationService.Failure.class)
    public ResponseEntity<?> failed(OptimizationService.Failure error){
        var response=ResponseEntity.status(error.status).header("Cache-Control","no-store");
        if(error.retryable)response.header("Retry-After","1");
        return response.body(Map.of("code",error.code,"message",error.getMessage(),"fieldErrors",List.of(),"traceId",UUID.randomUUID().toString(),"retryable",error.retryable,"details",Map.of()));
    }
    @ExceptionHandler(Exception.class)
    public ResponseEntity<?> unexpected(Exception error){
        String trace=UUID.randomUUID().toString();
        org.slf4j.LoggerFactory.getLogger(getClass()).error("Optimization API failed, traceId={}",trace,error);
        return ResponseEntity.status(503).body(Map.of("code","SERVICE_UNAVAILABLE","message","作业服务暂不可用，请凭 traceId 查询日志","fieldErrors",List.of(),"traceId",trace,"retryable",true,"details",Map.of()));
    }
}
