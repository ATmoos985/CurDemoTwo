package com.example.cutdemotwo;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class SiteEntryTests {
    @TempDir static Path temp;
    @DynamicPropertySource static void properties(DynamicPropertyRegistry registry) {
        registry.add("cutdemo.state.path", () -> temp.resolve("inventory.json").toString());
        registry.add("cutdemo.seed-demo-data", () -> false);
    }
    @Value("${local.server.port}") int port;
    private final HttpClient http = HttpClient.newHttpClient();

    private HttpResponse<String> get(String path) throws Exception {
        return http.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + path)).GET().build(),
                HttpResponse.BodyHandlers.ofString());
    }

    @Test void rootEntersNewAppWhileHistoricalWorkbenchRemainsAvailable() throws Exception {
        var root = get("/");
        assertEquals(302, root.statusCode());
        assertEquals("/app/", URI.create(root.headers().firstValue("location").orElseThrow()).getPath());
        assertTrue(get("/app/").body().contains("js/main.js"));
        var workbench = get("/index.html");
        assertEquals(200, workbench.statusCode());
        assertTrue(workbench.body().contains("data-product-nav=\"workbench\""), "通用操作台应保留在 /index.html");
    }

    @Test void everyEntryPageIsServed() throws Exception {
        for (String page : new String[]{"/intro.html", "/nesting.html", "/linear.html", "/linear-demo.html", "/inspection.html", "/inventory.html"}) {
            assertEquals(200, get(page).statusCode(), page);
        }
    }
}
