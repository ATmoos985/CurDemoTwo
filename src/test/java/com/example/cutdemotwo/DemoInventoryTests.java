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
        assertEquals(Map.of("rolls", 6, "remnants", 5), inventory.initializeDemoInventory());
        var restored = new RemnantService(new FileInventoryStore(path.toString()), false);
        assertEquals(6, restored.getMotherRolls().size());
        assertEquals(5, restored.getRemnantsByRollId(null).size());
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
}
