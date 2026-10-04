package com.example.cutdemotwo;

import com.example.cutdemotwo.model.*;
import com.example.cutdemotwo.service.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.*;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.*;
import tools.jackson.databind.ObjectMapper;
import java.net.URI;
import java.net.http.*;
import java.nio.file.Path;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT)
class PartialReportApiTests {
    @TempDir static Path temp;
    @DynamicPropertySource static void properties(DynamicPropertyRegistry r){r.add("cutdemo.state.path",()->temp.resolve("api.json").toString());r.add("cutdemo.seed-demo-data",()->true);}
    @Value("${local.server.port}") int port;
    @Autowired CuttingWorkflowService workflow;
    @Autowired RemnantService inventory;
    final ObjectMapper json=new ObjectMapper();
    HttpResponse<String> post(String path,String body)throws Exception{return HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+path))
            .header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString(body)).build(),HttpResponse.BodyHandlers.ofString());}
    SolveResponse plan(){var r=new SolveRequest();r.setRollL(3000);r.setWindowStartY(inventory.getMotherRoll(r.getRollId()).getUsedLength());r.setAllowLongitudinal(false);
        r.setDemands(List.of(new PieceDemand(77,"同一需求",2000,1000,3,false)));return workflow.solve(r);}
    CutReport report(SolveResponse p){return new CutReport(p.getPlanId(),2000,1,List.of(),"API",List.of(new CutReport.PieceResult(1,"QUALIFIED",""),
            new CutReport.PieceResult(2,"REJECTED","边缘破损"),new CutReport.PieceResult(3,"UNCUT","")));}
    @Test void actualHttpReportPersistsOutcomesAndCanBeReversed()throws Exception{
        var p=plan();double before=inventory.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength();
        var response=post("/api/cutting/report-confirm",json.writeValueAsString(report(p)));assertEquals(200,response.statusCode(),response.body());
        var body=json.readTree(response.body());assertEquals(1,body.get("finishedPieceCount").asInt());assertEquals("REJECTED",body.get("pieceResults").get(1).get("outcome").asText());
        assertEquals("边缘破损",body.get("pieceResults").get(1).get("reason").asText());assertEquals(2.0,body.get("pieceArea").asDouble());
        assertEquals(response.body(),post("/api/cutting/report-confirm",json.writeValueAsString(report(p))).body());
        assertEquals(200,post("/api/cutting/reports/"+p.getPlanId()+"/reverse","{\"reason\":\"API误报回滚\"}").statusCode());
        assertEquals(before,inventory.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
    }
    @Test void fractionalPieceIdentifierCannotBeSilentlyMappedToAnExistingPiece()throws Exception{
        var p=plan();String body=json.writeValueAsString(report(p));
        var response=post("/api/cutting/report-confirm",body.replace("\"pieceId\":1,","\"pieceId\":1.5,"));
        assertEquals(400,response.statusCode(),response.body());assertNull(inventory.getReceipt(p.getPlanId()));
    }
}
