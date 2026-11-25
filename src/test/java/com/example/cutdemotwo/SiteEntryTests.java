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

    @Test void rootRedirectsToModernAppEntry() throws Exception {
        var root = get("/");
        assertEquals(302, root.statusCode());
        assertEquals("/app/", URI.create(root.headers().firstValue("location").orElseThrow()).getPath());
        var app = get("/app/");
        assertEquals(200, app.statusCode());
        assertTrue(app.body().contains("js/main.js"));
    }
}
