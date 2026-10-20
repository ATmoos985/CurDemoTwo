package com.example.cutdemotwo.business.cutting;
import com.example.cutdemotwo.business.model.QualityDisposition;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.*;
import org.junit.jupiter.api.Test;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
class QualityDispositionRulesTests {
    final Shape concave = new Shape("POLYGON",1000,1000,List.of(new Point(0,0),new Point(1000,0),new Point(1000,1000),new Point(600,1000),new Point(600,400),new Point(400,400),new Point(400,1000),new Point(0,1000)));
    ReportOutput.ReportedPiece piece(String outcome){return new ReportOutput.ReportedPiece(1,1,"异形",0,0,1000,1000,outcome,"",concave,0);}
    QualityDisposition.Command recover(double x,double y,double w,double l){return new QualityDisposition.Command(UUID.randomUUID().toString(),0,1,"REMNANT","破损","甲",new QualityDisposition.Recovery(x,y,w,l,"B","RECOVERABLE"));}
    @Test void rejectsBoundingBoxAndRectangleCrossingConcaveNotchEvenWithAllCornersInside(){
        assertThrows(IllegalArgumentException.class,()->QualityDispositionRules.recoveredArea(recover(0,0,1000,1000),piece("QUALIFIED"),200,300));
        assertThrows(IllegalArgumentException.class,()->QualityDispositionRules.recoveredArea(recover(100,500,800,400),piece("QUALIFIED"),200,300));
        assertEquals(120000,QualityDispositionRules.recoveredArea(recover(0,0,400,300),piece("QUALIFIED"),200,300));
    }
    @Test void rejectsUncutNonfiniteUndersizedAndUnknownDispositions(){
        assertThrows(IllegalArgumentException.class,()->QualityDispositionRules.recoveredArea(recover(0,0,400,300),piece("UNCUT"),200,300));
        for(var r:List.of(recover(-1,0,400,300),recover(0,0,199,300),recover(0,0,400,299),recover(Double.NaN,0,400,300),recover(0,0,Double.POSITIVE_INFINITY,300)))
            assertThrows(IllegalArgumentException.class,()->QualityDispositionRules.recoveredArea(r,piece("QUALIFIED"),200,300));
        assertThrows(IllegalArgumentException.class,()->QualityDispositionRules.validateCommand(new QualityDisposition.Command("short",0,1,"REMNANT","原因","甲",null)));
        assertThrows(IllegalArgumentException.class,()->QualityDispositionRules.validateCommand(new QualityDisposition.Command(UUID.randomUUID().toString(),0,1,"SCRAP","原因","甲",recover(0,0,400,300).recovery())));
    }
}
