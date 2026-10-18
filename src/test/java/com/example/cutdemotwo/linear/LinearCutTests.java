package com.example.cutdemotwo.linear;

import changyang.cut.apsmodule.service.excel.ExcelImportService.OrderItem;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.junit.jupiter.api.Test;
import org.springframework.web.server.ResponseStatusException;
import java.io.ByteArrayInputStream;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import changyang.cut.apsmodule.service.*;
import changyang.cut.apsmodule.service.excel.*;
import changyang.cut.apsmodule.recut.*;
import org.springframework.mock.web.MockMultipartFile;

class LinearCutTests {
    static LinearCutRequest input(String name) {
        return new LinearCutRequest(4600,100,100,4400,4400,10,0,"FAST",List.of(
                new OrderItem(name,1100,8,1000,"单面处理")));
    }

    @Test void keepsPhysicalWidthAndRejectsInvalidProcessInput() {
        var request=input("A").toSolverRequest();
        assertEquals(4600,request.getTotalWidth());assertEquals(4400,request.getMaxWidth());
        assertTrue(request.isFlexibleWidth());
        assertThrows(IllegalArgumentException.class,()->new LinearCutRequest(4600,100,100,4300,4500,10,0,"FAST",input("A").orderItems()).toSolverRequest());
        assertThrows(IllegalArgumentException.class,()->new LinearCutRequest(4600,100,100,4400,4400,10,0,"FAST",List.of()).toSolverRequest());
    }

    @Test void nativeSolveSeparatesTasksAndRecutPreservesRepeatedStationsAndUndo() throws Exception {
        var service=new LinearCutService();
        try {
            String a=(String)service.create(input("订单 A")).get("taskId");
            String b=(String)service.create(input("订单 B")).get("taskId");
            var first=await(service,a);var other=await(service,b);
            assertEquals("SUCCEEDED",first.get("status"),first.toString());
            assertEquals("SUCCEEDED",other.get("status"),other.toString());
            var firstPreview=map(first.get("preview"));
            assertNotEquals(firstPreview.get("planId"),map(other.get("preview")).get("planId"));
            var groups=list(firstPreview.get("preview"));
            assertFalse(groups.isEmpty());
            assertTrue(firstPreview.toString().contains("订单 A"));
            assertFalse(firstPreview.toString().contains("订单 B"));
            assertEquals(8,production(first));
            assertThrows(ResponseStatusException.class,()->service.change(a,"undo",Map.of("planId","wrong","baseRevisionId","wrong")));
            var revision=String.valueOf(firstPreview.get("revisionId"));
            var command=new HashMap<String,Object>();
            command.put("planId",firstPreview.get("planId"));command.put("baseRevisionId",revision);
            command.put("selectedSequenceNumbers",groups.stream().map(g->g.get("sequenceNumber")).toList());
            service.change(a,"re-cut",command);
            var recut=await(service,a);
            assertEquals("SUCCEEDED",recut.get("status"),recut.toString());
            assertEquals(8,production(recut),"重切不能将四刀每卷的需求误减为一刀每卷");
            assertEquals(8,production(service.get(b)));
            var preview=map(recut.get("preview"));
            assertNotEquals(revision,preview.get("revisionId"));
            assertThrows(ResponseStatusException.class,()->service.change(a,"re-cut",command));
            service.change(a,"undo",Map.of("planId",preview.get("planId"),"baseRevisionId",preview.get("revisionId")));
            var restored=await(service,a);
            assertEquals("SUCCEEDED",restored.get("status"));assertEquals(8,production(restored));
            byte[] exported=service.export(a);
            try(var workbook=new XSSFWorkbook(new ByteArrayInputStream(exported))){assertNotNull(workbook.getSheet("分切工艺口径"));assertTrue(workbook.getSheetAt(0).getLastRowNum()>0);}
        } finally {service.close();}
    }

    @Test void recutFailureRestoresOriginalInstructionsAndDoesNotConsumeUndoHistory() {
        var excel=new ExcelExportService();
        var task=new LinearCutService.Task(input("回退测试"),excel,new ExcelProcessingService(new ExcelImportService(),excel));
        var solved=task.execution.execute(task.input.toSolverRequest());
        task.context.completeJob(task.context.createJob(),solved.result(),task.input.orderItems(),4600,solved.config());
        String before=excel.buildPreviewGroups(solved.result()).toString();
        var broken=mock(CuttingOptimizationService.class);
        when(broken.optimizeUnified(anyList(),any())).thenThrow(new IllegalStateException("模拟计算失败"));
        var recut=new ReCutApplicationService(task.context,excel,task.undo,broken);
        var command=new ReCutCommand();
        command.setSelectedSequenceNumbers(excel.buildPreviewGroups(solved.result()).stream().map(g->(Integer)g.get("sequenceNumber")).toList());
        assertEquals(false,recut.reCut(command).get("success"));
        assertEquals(before,excel.buildPreviewGroups(task.context.getLastOptimizationResult()).toString());
        assertEquals(0,task.undo.getUndoCount());
    }

    @Test void excelImportRejectsFractionalOrIncompleteRowsInsteadOfDroppingThem() throws Exception {
        var importer=new ExcelImportService();
        assertEquals(1,importer.parseExcelFileWithSource(excelInput(1100,false)).getOrderItems().size());
        assertThrows(java.io.IOException.class,()->importer.parseExcelFileWithSource(excelInput(1100.5,false)));
        assertThrows(java.io.IOException.class,()->importer.parseExcelFileWithSource(excelInput(1100,true)));
    }

    private MockMultipartFile excelInput(double width,boolean invalidExtraRow) throws Exception {
        try(var book=new XSSFWorkbook();var bytes=new java.io.ByteArrayOutputStream()) {
            var sheet=book.createSheet("需求");
            String[] headers={"消息文本","宽度mm","卷数","长度m","表面处理"};
            var header=sheet.createRow(0);for(int i=0;i<headers.length;i++)header.createCell(i).setCellValue(headers[i]);
            var row=sheet.createRow(1);row.createCell(0).setCellValue("订单 A");row.createCell(1).setCellValue(width);
            row.createCell(2).setCellValue(8);row.createCell(3).setCellValue(1000);row.createCell(4).setCellValue("单面处理");
            if(invalidExtraRow)sheet.createRow(2).createCell(0).setCellValue("残缺订单");
            book.write(bytes);return new MockMultipartFile("file","orders.xlsx","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",bytes.toByteArray());
        }
    }

    static Map<String,Object> await(LinearCutService service,String id) throws Exception {
        long deadline=System.nanoTime()+java.time.Duration.ofSeconds(90).toNanos();
        while(System.nanoTime()<deadline){var result=service.get(id);if(!result.get("status").equals("RUNNING"))return result;Thread.sleep(50);}
        fail("一维求解未在 90 秒内结束");return null;
    }
    @SuppressWarnings("unchecked") static Map<String,Object> map(Object value){return (Map<String,Object>)value;}
    @SuppressWarnings("unchecked") static List<Map<String,Object>> list(Object value){return (List<Map<String,Object>>)value;}
    static int production(Map<String,Object> snapshot){return list(map(snapshot.get("result")).get("patterns")).stream()
            .mapToInt(p->map(p.get("subRolls")).values().stream().mapToInt(n->((Number)n).intValue()).sum()*((Number)p.get("usageCount")).intValue()).sum();}
}
