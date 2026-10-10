package com.example.cutdemotwo;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;

@SpringBootTest
class CutDemoTwoApplicationTests {
    @org.junit.jupiter.api.io.TempDir
    static java.nio.file.Path testState;

    @org.springframework.test.context.DynamicPropertySource
    static void isolatedInventory(org.springframework.test.context.DynamicPropertyRegistry registry) {
        registry.add("cutdemo.state.path", () -> testState.resolve("inventory.json").toString());
    }

    @Test
    void contextLoads() {
    }

}
