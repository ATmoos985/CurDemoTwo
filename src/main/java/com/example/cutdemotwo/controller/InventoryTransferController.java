package com.example.cutdemotwo.controller;

import com.example.cutdemotwo.business.cutting.RemnantService;
import com.example.cutdemotwo.business.model.InventoryTransfer;
import com.example.cutdemotwo.persistence.InventoryConflictException;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.ResponseEntity;
import tools.jackson.databind.*;
import tools.jackson.databind.json.JsonMapper;
import java.io.*;
import java.util.Map;

@RestController
@RequestMapping("/api/v2/inventory-transfers")
public class InventoryTransferController {
    private final RemnantService inventory;
    private final JsonMapper json=JsonMapper.builder().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES,
            DeserializationFeature.FAIL_ON_TRAILING_TOKENS,DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES,
            DeserializationFeature.FAIL_ON_MISSING_CREATOR_PROPERTIES)
            .enable(tools.jackson.core.StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT).disable(MapperFeature.ALLOW_COERCION_OF_SCALARS).build();
    public InventoryTransferController(RemnantService inventory){this.inventory=inventory;}
    @GetMapping public Object list(){return inventory.inventoryTransfers();}
    @GetMapping("/options") public Object options(){return inventory.transferOptions();}
    @PostMapping public Object post(@RequestHeader(value="Idempotency-Key",required=false) String key,InputStream body) {
        try {
            byte[] bytes=body.readNBytes(262145);
            if(bytes.length>262144)throw new IllegalArgumentException("请求正文最多 262144 字节");
            return inventory.transferInventory(key,json.readValue(bytes,InventoryTransfer.Command.class));
        }catch(IOException | tools.jackson.core.JacksonException error){throw new IllegalArgumentException("JSON 字段或类型无效，请核对移库单契约");}
    }
    @ExceptionHandler(InventoryConflictException.class) public ResponseEntity<?> conflict(InventoryConflictException error){return ResponseEntity.status(409).body(Map.of("code","INVENTORY_CONFLICT","message",error.getMessage()));}
    @ExceptionHandler(IllegalArgumentException.class) public ResponseEntity<?> invalid(IllegalArgumentException error){return ResponseEntity.badRequest().body(Map.of("code","INVALID_INPUT","message",error.getMessage()));}
}
