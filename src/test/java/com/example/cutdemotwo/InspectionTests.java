package com.example.cutdemotwo;

import com.example.cutdemotwo.model.*;
import com.example.cutdemotwo.service.RemnantService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class InspectionTests {
    @TempDir Path temp;
    private RemnantService inventory() { return new RemnantService(temp.resolve("inspection.json").toString()); }
    private MotherRollInfo roll(RemnantService service) {
        var r = new MotherRollInfo(); r.setRollId("INSPECT-1"); r.setRollModel("棉布"); r.setWidth(2000); r.setTotalLength(100000);
        return service.createInspectionRoll(r);
    }
    private Defect defect(String key, double y) {
        var d = new Defect(0, 100.1, y, 50.2, 60.3, 20); d.setCaptureId(key); d.setDetectionSource("MANUAL_INSPECT"); return d;
    }
    private RemnantService.InspectionInput input(Defect... ds) { return new RemnantService.InspectionInput(2000,100000,List.of(ds)); }
    @Test void savesWholeRollCoordinatesAndPreservesInventoryOnRetryAndRestart() {
        var s=inventory();roll(s);
        s.addDefectToRoll("INSPECT-1",new Defect(0,0,1000,100,100,20));
        var batch=input(defect("capture-1",12345.6),defect("capture-2",80000));
        var result=s.saveInspection("INSPECT-1",batch);
        assertEquals(3,result.getDefectsCount());assertEquals(100000,result.getCurrentRemainingLength());assertEquals(0,result.getUsedLength());
        assertEquals("PENDING",result.getInspectionStatus());
        var restarted=inventory();assertEquals(3,restarted.saveInspection("INSPECT-1",batch).getDefectsCount());
        assertEquals(12345.6,restarted.getMotherRoll("INSPECT-1").getDefects().get(1).getY());
    }
    @Test void invalidBatchIsAtomicAndChangedRetryCannotOverwrite() {
        var s=inventory();roll(s);var good=defect("good",1000);var bad=defect("bad",99990);
        assertThrows(IllegalArgumentException.class,()->s.saveInspection("INSPECT-1",input(good,bad)));
        assertEquals(0,s.getMotherRoll("INSPECT-1").getDefectsCount());
        s.saveInspection("INSPECT-1",input(good));good.setW(99);
        assertThrows(IllegalArgumentException.class,()->s.saveInspection("INSPECT-1",input(good)));
        assertEquals(50.2,s.getMotherRoll("INSPECT-1").getDefects().get(0).getW());
    }
    @Test void rejectsDuplicateKeysInvalidPrecisionMarginAndStaleDimensions() {
        var s=inventory();roll(s);var d=defect("one",1000);
        assertThrows(IllegalArgumentException.class,()->s.saveInspection("INSPECT-1",input(d,d)));
        assertThrows(IllegalArgumentException.class,()->s.saveInspection("INSPECT-1",new RemnantService.InspectionInput(2100,100000,List.of(d))));
        d.setMargin(-1);assertThrows(IllegalArgumentException.class,()->s.saveInspection("INSPECT-1",input(d)));
        d.setMargin(20);d.setX(.15);assertThrows(IllegalArgumentException.class,()->s.saveInspection("INSPECT-1",input(d)));
        assertEquals(0,s.getMotherRoll("INSPECT-1").getDefectsCount());
    }
    @Test void registeringAnExistingRollCannotOverwriteMetadata() {
        var s=inventory();var first=roll(s);first.setRollModel("改变");
        assertThrows(IllegalArgumentException.class,()->s.createInspectionRoll(first));
        assertEquals("棉布",inventory().getMotherRoll("INSPECT-1").getRollModel());
    }
    @Test void oldDefectJsonDoesNotGainNullCaptureFieldOrInvalidateSavedPlanFingerprint() {
        var json=new tools.jackson.databind.ObjectMapper();
        assertFalse(json.writeValueAsString(new Defect(1,0,0,50,50,20)).contains("captureId"));
        assertTrue(json.writeValueAsString(defect("capture",0)).contains("captureId"));
    }
}
