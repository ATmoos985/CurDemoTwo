package com.example.cutdemotwo.controller;

import com.example.cutdemotwo.business.cutting.RemnantService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import java.util.Map;

/** Read-only accounting queries; all booking remains in the business command transaction. */
@RestController
@RequestMapping("/api/v2/inventory-ledger")
public class InventoryLedgerController {
    private final RemnantService inventory;
    public InventoryLedgerController(RemnantService inventory) { this.inventory=inventory; }
    @GetMapping public Object entries(@RequestParam(required=false) String aggregateType,
            @RequestParam(required=false) String aggregateId,@RequestParam(defaultValue="0") long after,
            @RequestParam(defaultValue="100") int limit) {
        return inventory.inventoryLedger(aggregateType,aggregateId,after,limit);
    }
    @GetMapping("/reconciliation") public Object reconcile() { return inventory.reconcileInventory(); }
    @ExceptionHandler(IllegalArgumentException.class) public ResponseEntity<?> invalid(IllegalArgumentException e) {
        return ResponseEntity.badRequest().body(Map.of("code","INVALID_INPUT","message",e.getMessage()));
    }
}
