package com.example.cutdemotwo.algorithm.slitting;

import com.example.cutdemotwo.contracts.slitting.SlittingProblem;
import com.example.cutdemotwo.contracts.slitting.SlittingResult;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class LinearSlittingSolverEngineTests {

    private final LinearSlittingSolverEngine engine = new LinearSlittingSolverEngine();

    @Test
    void standardProblemSolvesFeasibleWithValidFulfillment() {
        var problem = new SlittingProblem("1", "mm", 1200, 10, 10, 1000, 1180, 10, 10, "FAST",
                List.of(
                        new SlittingProblem.Order("O1", 500, 3000, 4, "素色"),
                        new SlittingProblem.Order("O2", 600, 3000, 2, "素色")
                ), 10);

        SlittingResult result = engine.solve(problem);

        assertEquals("FEASIBLE", result.status());
        assertEquals("ortools-1d", result.engine());
        assertFalse(result.patterns().isEmpty());
        assertEquals(2, result.fulfillment().size());

        var f1 = result.fulfillment().stream().filter(f -> f.orderId().equals("O1")).findFirst().orElseThrow();
        assertEquals(4, f1.requested());
        assertEquals(4, f1.produced());
        assertEquals(0, f1.missing());

        var f2 = result.fulfillment().stream().filter(f -> f.orderId().equals("O2")).findFirst().orElseThrow();
        assertEquals(2, f2.requested());
        assertEquals(2, f2.produced());
        assertEquals(0, f2.missing());

        assertTrue(result.pieceAreaMm2() > 0);
        assertTrue(result.motherAreaMm2() >= result.usableAreaMm2());
    }

    @Test
    void malformedKernelOutputNeverGuessesAssignmentsOrSubstitutesRollLength() {
        var p=new SlittingProblem("1","mm",1000,0,0,1000,1000,1,0,"FAST",
                List.of(new SlittingProblem.Order("external-A",500,1000,2,"A")),10);
        var raw=new changyang.cut.apsmodule.service.CuttingInstruction();
        raw.setRollWidth(1000);raw.setLength(1);raw.setSurfaceTreatment("A");raw.setUsageCount(1);
        raw.setSubRolls(java.util.Map.of(500,2));
        assertThrows(com.example.cutdemotwo.contracts.slitting.SlittingValidation.ValidationException.class,
                ()->LinearSlittingSolverEngine.convert(p,List.of(raw)));
        raw.setStationAssignments(List.of(new changyang.cut.apsmodule.service.StationAssignment(500,"external-A"),
                new changyang.cut.apsmodule.service.StationAssignment(500,"external-A")));
        assertEquals(2,LinearSlittingSolverEngine.convert(p,List.of(raw)).fulfillment().get(0).produced());
        raw.setLength(2);
        assertThrows(com.example.cutdemotwo.contracts.slitting.SlittingValidation.ValidationException.class,
                ()->LinearSlittingSolverEngine.convert(p,List.of(raw)));
    }
    @Test @org.junit.jupiter.api.Timeout(15)
    void cancellationWaitsForOwnedChildProcessToExit() throws Exception {
        var p=new SlittingProblem("1","mm",1200,10,10,1000,1180,10,10,"QUALITY",
                List.of(new SlittingProblem.Order("O1",500,3000,400,"A"),new SlittingProblem.Order("O2",600,3000,200,"A")),30);
        var error=new java.util.concurrent.atomic.AtomicReference<Throwable>();
        Thread worker=new Thread(()->{try{engine.solve(p);}catch(Throwable e){error.set(e);}});
        var existing=ProcessHandle.current().children().map(ProcessHandle::pid).collect(java.util.stream.Collectors.toSet());
        worker.start();ProcessHandle child=null;
        try {
            long deadline=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(5);
            while(child==null && worker.isAlive() && System.nanoTime()<deadline) {
                child=newJavaChildren(existing).findFirst().orElse(null);
                if(child==null)Thread.sleep(2);
            }
            assertNotNull(child,"must observe the actual solver JVM; worker failure="+error.get());
            assertTrue(child.isAlive());
            worker.interrupt();worker.join(5000);
            assertFalse(worker.isAlive());assertFalse(child.isAlive());assertInstanceOf(java.util.concurrent.CancellationException.class,error.get());
        } finally {
            // An observation/assertion failure must not leave the solver running into the next test.
            worker.interrupt();worker.join(5000);
            if(child!=null && child.isAlive())child.destroyForcibly();
        }
    }

    private static java.util.stream.Stream<ProcessHandle> newJavaChildren(java.util.Set<Long> existing) {
        // Linux JDK 17 only reads one page of argv. The test classpath exceeds that page,
        // so the main class after -cp is absent from commandLine(). Use owned PID + executable.
        return ProcessHandle.current().children().filter(c->!existing.contains(c.pid()) && c.isAlive()
                && c.info().command().map(command->java.nio.file.Path.of(command).getFileName().toString())
                .filter(name->name.equals("java") || name.equals("java.exe")).isPresent());
    }
    @Test @org.junit.jupiter.api.Timeout(15)
    void childSelfTerminatesWhenParentNoLongerExists(@org.junit.jupiter.api.io.TempDir java.nio.file.Path temp) throws Exception {
        var p=new SlittingProblem("1","mm",1200,10,10,1000,1180,10,10,"QUALITY",
                List.of(new SlittingProblem.Order("O1",500,3000,4,"A")),10);
        var input=temp.resolve("input.json");var output=temp.resolve("output.json");
        java.nio.file.Files.write(input,tools.jackson.databind.json.JsonMapper.builder().build().writeValueAsBytes(p));
        var command=LinearSlittingSolverEngine.command(input,output,Long.MAX_VALUE);
        var child=new ProcessBuilder(command).redirectOutput(ProcessBuilder.Redirect.DISCARD).redirectError(ProcessBuilder.Redirect.DISCARD).start();
        try {assertTrue(child.waitFor(8,java.util.concurrent.TimeUnit.SECONDS));assertEquals(124,child.exitValue());}
        finally{if(child.isAlive()){child.destroyForcibly();child.waitFor();}}
    }
 @Test void sameWidthDifferentLengthAndSurfaceRetainIdentity(){
  var p=new SlittingProblem("1","mm",1200,10,10,1000,1180,10,0,"FAST",List.of(
   new SlittingProblem.Order("A",500,3000,2,"plain"),new SlittingProblem.Order("B",500,6000,2,"plain"),
   new SlittingProblem.Order("C",500,3000,2,"coated"),new SlittingProblem.Order("D",500,6000,2,"coated")),20);
  var r=new LinearSlittingSolverEngine().solve(p);
  assertEquals("FEASIBLE",r.status());assertEquals(4,r.fulfillment().size());
  assertTrue(r.fulfillment().stream().allMatch(f->f.produced()==2 && f.missing()==0));
 }
 public static class ParentMain {
  public static void main(String[] args) throws Exception {
   var p=tools.jackson.databind.json.JsonMapper.builder().build().readValue(java.nio.file.Files.readAllBytes(java.nio.file.Path.of(args[0])),SlittingProblem.class);
   new LinearSlittingSolverEngine().solve(p);
  }
 }
 @Test void actualParentDeathStopsLiveChild(@org.junit.jupiter.api.io.TempDir java.nio.file.Path temp) throws Exception {
  var in=temp.resolve("parent-input.json");java.nio.file.Files.write(in,tools.jackson.databind.json.JsonMapper.builder().build().writeValueAsBytes(new SlittingProblem("1","mm",1200,10,10,1000,1180,10,0,"FAST",List.of(new SlittingProblem.Order("A",500,3000,4,"plain")),20)));
  var parent=new ProcessBuilder(java.nio.file.Path.of(System.getProperty("java.home"),"bin","java").toString(),"-cp",System.getProperty("surefire.test.class.path",System.getProperty("java.class.path")),ParentMain.class.getName(),in.toString()).redirectOutput(ProcessBuilder.Redirect.DISCARD).redirectError(ProcessBuilder.Redirect.DISCARD).start();
  ProcessHandle child=null;
  try {
   long limit=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(10);
   while(System.nanoTime()<limit && child==null){child=parent.children().findFirst().orElse(null);Thread.sleep(2);}
   assertNotNull(child,"supervisor must launch real solver child");parent.destroyForcibly();assertTrue(parent.waitFor(5,java.util.concurrent.TimeUnit.SECONDS));
   limit=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(5);
   while(System.nanoTime()<limit && child.isAlive())Thread.sleep(20);
   assertFalse(child.isAlive(),"child JVM must self-stop after real supervisor death");
  } finally {parent.destroyForcibly();parent.waitFor();if(child!=null && child.isAlive())child.destroyForcibly();}
 }

    @Test @org.junit.jupiter.api.Timeout(15)
    void wallClockTimeoutStopsProcessWithManyIndependentGroups() {
        var orders=java.util.stream.IntStream.range(0,500).mapToObj(i->
                new SlittingProblem.Order("group-"+i,500,3000,2,"surface-"+i)).toList();
        var p=new SlittingProblem("1","mm",1200,10,10,1000,1180,10,0,"QUALITY",orders,1);
        var existing=ProcessHandle.current().children().map(ProcessHandle::pid).collect(java.util.stream.Collectors.toSet());
        long start=System.nanoTime();
        assertThrows(com.example.cutdemotwo.algorithm.api.ComputationTimeout.class,()->engine.solve(p));
        assertTrue(System.nanoTime()-start<java.util.concurrent.TimeUnit.SECONDS.toNanos(8));
        assertTrue(newJavaChildren(existing).findAny().isEmpty(),"timeout must leave no owned solver JVM alive");
    }
}
