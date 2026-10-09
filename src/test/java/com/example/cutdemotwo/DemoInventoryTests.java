package com.example.cutdemotwo;

import com.example.cutdemotwo.persistence.*;
import com.example.cutdemotwo.service.RemnantService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.*;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;

class DemoInventoryTests {
    @TempDir Path temp;

    @Test void explicitInitializationPersistsBothStockTypesAndRejectsRepeat() throws Exception {
        Path path = temp.resolve("demo.json");
        var inventory = new RemnantService(new FileInventoryStore(path.toString()), false);
        assertTrue(inventory.getMotherRolls().isEmpty());
        assertEquals(Map.of("rolls", 31, "remnants", 98), inventory.initializeDemoInventory());
        var restored = new RemnantService(new FileInventoryStore(path.toString()), false);
        assertEquals(31, restored.getMotherRolls().size());
        assertEquals(98, restored.getRemnantsByRollId(null).size());
        assertTrue(restored.getMotherRolls().stream().allMatch(roll -> roll.getStorageLocation().contains("非实物")));
        byte[] before = Files.readAllBytes(path);
        assertThrows(IllegalArgumentException.class, restored::initializeDemoInventory);
        assertArrayEquals(before, Files.readAllBytes(path));
    }

    @Test void initializationNeverOverwritesExistingInventory() throws Exception {
        Path path = temp.resolve("existing.json");
        var inventory = new RemnantService(path.toString());
        inventory.scrapRemnant("REM-202609-001", "already handled");
        byte[] before = Files.readAllBytes(path);
        assertThrows(IllegalArgumentException.class, inventory::initializeDemoInventory);
        assertNull(inventory.scanOrGetById("REM-202609-001"));
        assertArrayEquals(before, Files.readAllBytes(path));
    }

    @Test void failedInitializationLeavesNoPartiallyCreatedMaterials() {
        var store = new InventoryStore() {
            public InventorySnapshot load() { return null; }
            public long save(InventorySnapshot snapshot) { throw new IllegalStateException("storage unavailable"); }
        };
        var inventory = new RemnantService(store, false);
        assertThrows(IllegalStateException.class, inventory::initializeDemoInventory);
        assertTrue(inventory.getMotherRolls().isEmpty());
        assertTrue(inventory.getRemnantsByRollId(null).isEmpty());
    }

    @Test void orderDemoStockCoversEveryFabricAndPreservesExistingStockOnRepeat() throws Exception {
        Path path = temp.resolve("orders.json");
        var inventory = new RemnantService(path.toString());
        inventory.scrapRemnant("REM-202609-001", "already handled");
        var before = inventory.getMotherRoll("ROLL-REAL-893153");
        double remaining = before.getCurrentRemainingLength();
        assertEquals(Map.of("rolls",25,"remnants",93), inventory.prepareOrderDemoInventory());
        assertEquals(31,inventory.getMotherRolls().size());
        assertEquals(remaining,inventory.getMotherRoll("ROLL-REAL-893153").getCurrentRemainingLength());
        for(var roll : inventory.getMotherRolls()) {
            var seeded = inventory.getRemnantsByRollId(roll.getRollId()).stream().filter(r->r.getId().startsWith("DEMO-REM-")).toList();
            assertEquals(3,seeded.size());
            assertTrue(seeded.stream().allMatch(r->r.getMaterialBatch().equals(roll.getRollModel()) && r.getWidth() <= roll.getWidth()));
            assertTrue(seeded.stream().anyMatch(r->r.isHasDefect() && !r.getDefects().isEmpty()));
        }
        String id="DEMO-REM-ROLL-REAL-893153-1";
        inventory.scrapRemnant(id,"demo complete");
        assertEquals(Map.of("rolls",0,"remnants",0),inventory.prepareOrderDemoInventory());
        var restored = new RemnantService(new FileInventoryStore(path.toString()), "true");
        assertNull(restored.scanOrGetById(id));
        assertNull(restored.scanOrGetById("REM-202609-001"));
        assertEquals(31,restored.getMotherRolls().size());
        assertTrue(restored.getMotherRoll("ROLL-DEMO-928-893295").getWidth() >= 2865);
    }
}
