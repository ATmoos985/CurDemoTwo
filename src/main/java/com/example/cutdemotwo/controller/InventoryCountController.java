package com.example.cutdemotwo.controller;

import com.example.cutdemotwo.business.cutting.RemnantService;
import com.example.cutdemotwo.business.model.InventoryCount;
import com.example.cutdemotwo.persistence.InventoryConflictException;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.ResponseEntity;
import tools.jackson.databind.*;
import tools.jackson.databind.json.JsonMapper;
import java.io.*;
import java.util.Map;

@RestController
@RequestMapping("/api/v2/inventory-counts")
public class InventoryCountController {
    private final RemnantService inventory;
    private final JsonMapper json=JsonMapper.builder().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES,
            DeserializationFeature.FAIL_ON_TRAILING_TOKENS,DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES,
            DeserializationFeature.FAIL_ON_MISSING_CREATOR_PROPERTIES)
            .enable(tools.jackson.core.StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT).disable(MapperFeature.ALLOW_COERCION_OF_SCALARS).build();
    public InventoryCountController(RemnantService inventory){this.inventory=inventory;}
    @GetMapping public Object list(){return inventory.inventoryCounts();}
    @GetMapping("/options") public Object options(){return inventory.countOptions();}
    @PostMapping public Object post(@RequestHeader(value="Idempotency-Key",required=false) String key,InputStream body) {
        try {
            byte[] bytes=body.readNBytes(262145);
            if(bytes.length>262144)throw new IllegalArgumentException("请求正文最多 262144 字节");
            var tree=json.readTree(bytes);
            if(tree==null || !tree.isObject() || !tree.path("reason").isString() || !tree.path("operator").isString()
                    || !tree.path("expectedRevision").isIntegralNumber() || !tree.path("materials").isArray())
                throw new IllegalArgumentException("盘点单需要整数版本、字符串原因/经办人和材料数组");
            for(var line:tree.path("materials"))if(!line.isObject() || !line.path("type").isString() || !line.path("id").isString()
                    || !line.path("present").isBoolean() || !line.path("width").isNumber() || !line.path("length").isNumber())
                throw new IllegalArgumentException("材料需要字符串身份、布尔在场标记及数字实测尺寸");
            return inventory.countInventory(key,json.treeToValue(tree,InventoryCount.Command.class));
        }catch(IOException | tools.jackson.core.JacksonException error){throw new IllegalArgumentException("JSON 字段或类型无效，请核对盘点单契约");}
    }
    @ExceptionHandler(InventoryConflictException.class) public ResponseEntity<?> conflict(InventoryConflictException error){return ResponseEntity.status(409).body(Map.of("code","INVENTORY_CONFLICT","message",error.getMessage()));}
    @ExceptionHandler(IllegalArgumentException.class) public ResponseEntity<?> invalid(IllegalArgumentException error){return ResponseEntity.badRequest().body(Map.of("code","INVALID_INPUT","message",error.getMessage()));}
}
