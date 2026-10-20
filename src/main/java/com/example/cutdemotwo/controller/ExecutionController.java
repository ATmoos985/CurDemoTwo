package com.example.cutdemotwo.controller;

import com.example.cutdemotwo.business.cutting.RemnantService;
import com.example.cutdemotwo.business.model.*;
import com.example.cutdemotwo.persistence.InventoryConflictException;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.ResponseEntity;
import tools.jackson.databind.*;
import tools.jackson.databind.json.JsonMapper;
import java.io.*;
import java.util.*;

/** HTTP adapter; execution, reservations and inventory share one business transaction. */
@RestController
@RequestMapping("/api/v2/execution-orders")
public class ExecutionController {
    private final RemnantService inventory;
    private final JsonMapper json=JsonMapper.builder().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES,
            DeserializationFeature.FAIL_ON_TRAILING_TOKENS,DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES)
            .enable(tools.jackson.core.StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT).disable(MapperFeature.ALLOW_COERCION_OF_SCALARS).build();
    public ExecutionController(RemnantService inventory){this.inventory=inventory;}
    @GetMapping public Object list(@RequestParam(required=false) String taskId){return inventory.executionOrders(taskId);}
    @GetMapping("/{id}") public Object get(@PathVariable String id){return inventory.executionOrder(id);}
    @PostMapping public Object create(@RequestHeader(value="Idempotency-Key",required=false) String key,InputStream body){
        return inventory.createExecution(key,decode(body,ExecutionOrder.Create.class));
    }
    @PostMapping("/{id}/release") public Object release(@PathVariable String id,InputStream body){return change(id,"release",body);}
    @PostMapping("/{id}/start") public Object start(@PathVariable String id,InputStream body){return change(id,"start",body);}
    @PostMapping("/{id}/cancel") public Object cancel(@PathVariable String id,InputStream body){return change(id,"cancel",body);}
    @PostMapping("/{id}/reports") public Object report(@PathVariable String id,InputStream body){return inventory.reportExecution(id,decode(body,CutReport.class));}
    private Object change(String id,String action,InputStream body){return inventory.changeExecution(id,action,decode(body,ExecutionOrder.Command.class));}
    private <T>T decode(InputStream body,Class<T> type){
        try {byte[] bytes=body.readNBytes(262145);if(bytes.length>262144)throw new IllegalArgumentException("请求正文最多 262144 字节");return json.readValue(bytes,type);}
        catch(IOException | tools.jackson.core.JacksonException error){throw new IllegalArgumentException("JSON 字段或类型无效，请核对执行单契约");}
    }
    @ExceptionHandler(InventoryConflictException.class) public ResponseEntity<?> conflict(InventoryConflictException e){return ResponseEntity.status(409).body(Map.of("code","EXECUTION_CONFLICT","message",e.getMessage()));}
    @ExceptionHandler(IllegalArgumentException.class) public ResponseEntity<?> invalid(IllegalArgumentException e){return ResponseEntity.badRequest().body(Map.of("code","INVALID_INPUT","message",e.getMessage()));}
}
