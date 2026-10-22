package com.example.cutdemotwo.controller;

import com.example.cutdemotwo.business.integration.IntegrationService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import tools.jackson.databind.*;
import tools.jackson.databind.json.JsonMapper;
import java.io.*;
import java.util.Map;

@RestController
@RequestMapping("/api/v2/integration-deliveries")
public class IntegrationController {
    private final IntegrationService service;
    private final JsonMapper json=JsonMapper.builder().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES,
            DeserializationFeature.FAIL_ON_TRAILING_TOKENS,DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES)
            .enable(tools.jackson.core.StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT).disable(MapperFeature.ALLOW_COERCION_OF_SCALARS).build();
    public IntegrationController(IntegrationService service){this.service=service;}
    @GetMapping public Object list(@RequestHeader(value="Authorization",required=false) String auth,
            @RequestParam(defaultValue="0") long after,@RequestParam(defaultValue="20") int limit){
        service.authenticate(auth);return service.list(after,limit);
    }
    @PostMapping("/claims") public Object claim(@RequestHeader(value="Authorization",required=false) String auth,InputStream input){
        service.authenticate(auth);return service.claim(decode(input,IntegrationService.Claim.class));
    }
    @PostMapping("/{id}/acknowledgements") public Object acknowledge(@RequestHeader(value="Authorization",required=false) String auth,
            @PathVariable String id,InputStream input){
        service.authenticate(auth);return service.acknowledge(id,decode(input,IntegrationService.Acknowledgement.class));
    }
    private <T> T decode(InputStream input,Class<T> type){
        try{
            byte[] bytes=input.readNBytes(8193);
            if(bytes.length>8192)throw new IllegalArgumentException("集成命令正文最多 8192 字节");
            JsonNode tree=json.readTree(bytes);
            if(tree==null || !tree.isObject())throw new IllegalArgumentException("集成命令必须为 JSON 对象");
            for(var field:tree.properties())if(!field.getValue().isString() && !field.getValue().isNull())
                throw new IllegalArgumentException("集成命令字段必须为字符串或可选 null");
            return json.treeToValue(tree,type);
        }
        catch(IOException|tools.jackson.core.JacksonException error){throw new IllegalArgumentException("JSON 字段或类型无效，请核对集成契约");}
    }
    @ExceptionHandler(IntegrationService.Failure.class) public ResponseEntity<?> failure(IntegrationService.Failure error){
        var response=ResponseEntity.status(error.status);
        if(error.status==401)response.header("WWW-Authenticate","Bearer realm=\"cutting-integration\"");
        return response.body(Map.of("code",error.code,"message",error.getMessage(),"retryable",error.retryable));
    }
    @ExceptionHandler(IllegalArgumentException.class) public ResponseEntity<?> invalid(IllegalArgumentException error){
        return ResponseEntity.badRequest().body(Map.of("code","INVALID_INPUT","message",error.getMessage(),"retryable",false));
    }
    @ExceptionHandler(org.springframework.beans.TypeMismatchException.class)
    public ResponseEntity<?> invalidParameter(Exception error){
        return ResponseEntity.badRequest().body(Map.of("code","INVALID_INPUT","message","分页参数必须为有效整数","retryable",false));
    }
    @ExceptionHandler({IllegalStateException.class,org.springframework.dao.DataAccessException.class})
    public ResponseEntity<?> unavailable(Exception error){
        return ResponseEntity.status(503).body(Map.of("code","INTEGRATION_STORAGE_UNAVAILABLE","message","集成存储暂不可用，请保留原 requestId 和回执正文重试","retryable",true));
    }
}
