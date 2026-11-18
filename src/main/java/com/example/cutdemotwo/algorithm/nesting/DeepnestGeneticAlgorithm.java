package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.algorithm.ComputationCancellation;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.SplittableRandom;

/**
 * Evolutionary insertion-order, discrete-orientation, and placement-mode optimizer migrated from
 * {@code D:\GitHub\Deepnest\main\deepnest.js} ({@code GeneticAlgorithm}, lines 1329-1463).
 *
 * <p>Each {@link Individual} encodes:
 * <ul>
 *   <li>{@code order}: permutation of expanded part instance indices {@code 0 .. N-1};</li>
 *   <li>{@code rotations}: discrete orientation in degrees for each position in {@code order},
 *       always drawn strictly from that part's allowed {@code contourAngles()};</li>
 *   <li>{@code placementMode}: Deepnest placement scoring mode ({@code GRAVITY_Y}, {@code BOX_AREA},
 *       {@code GRAVITY_X}, or {@code TIGHT_CORNER});</li>
 *   <li>{@code greedyAngles}: optional seed flag instructing the NFP placement decoder to test all
 *       allowed angles at each step and write the winning orientations back into {@code rotations}.</li>
 * </ul>
 */
final class DeepnestGeneticAlgorithm {

    enum PlacementMode {
        /** Deepnest 'gravity' along Y feed axis: compresses marker strip length (Y) first. */
        GRAVITY_Y,
        /** Deepnest 'box' mode: minimizes bounding rectangle area (width * height) symmetrically. */
        BOX_AREA,
        /** Deepnest 'gravity' along X axis: packs tightly into left/right pockets of concave sheets. */
        GRAVITY_X,
        /** Origin-distance / tightest corner pocket fill with strong common-line bonus. */
        TIGHT_CORNER
    }

    private static final PlacementMode[] MODES = PlacementMode.values();

    interface PartDescriptor {
        int instanceId();
        int demandId();
        double area();
        double primaryHeight();
        double primaryWidth();
        List<Integer> allowedAngles();
    }

    static final class Individual {
        final int[] order;
        final int[] rotations;
        final PlacementMode placementMode;
        final boolean greedyAngles;
        double fitness = Double.NaN;
        boolean evaluated = false;

        Individual(int[] order, int[] rotations, PlacementMode placementMode, boolean greedyAngles) {
            this.order = order;
            this.rotations = rotations;
            this.placementMode = placementMode;
            this.greedyAngles = greedyAngles;
        }
    }

    private final List<? extends PartDescriptor> items;
    private final int populationSize;
    private final int mutationRate;
    private final SplittableRandom rng;
    private List<Individual> population;

    DeepnestGeneticAlgorithm(List<? extends PartDescriptor> items,
                             int populationSize,
                             int mutationRate,
                             long seed) {
        this.items = items;
        this.populationSize = Math.max(6, populationSize);
        this.mutationRate = Math.max(1, mutationRate);
        this.rng = new SplittableRandom(seed);
        this.population = initPopulation();
    }

    List<Individual> population() {
        return population;
    }

    private List<Individual> initPopulation() {
        int n = items.size();
        List<Individual> pop = new ArrayList<>(populationSize);

        // Seed 0 (Deepnest "Adam", deepnest.js:1082): decreasing true polygon area, canonical first allowed angle
        Integer[] byAreaDesc = new Integer[n];
        for (int i = 0; i < n; i++) byAreaDesc[i] = i;
        Arrays.sort(byAreaDesc, Comparator
                .comparingDouble((Integer idx) -> items.get(idx).area()).reversed()
                .thenComparingInt(idx -> items.get(idx).demandId())
                .thenComparingInt(Integer::intValue));

        int[] adamOrder = toPrimitive(byAreaDesc);
        int[] canonicalRot = new int[n];
        for (int i = 0; i < n; i++) {
            canonicalRot[i] = items.get(adamOrder[i]).allowedAngles().get(0);
        }
        pop.add(new Individual(adamOrder.clone(), canonicalRot.clone(), PlacementMode.GRAVITY_Y, false));

        // Seed 1: decreasing area with greedy multi-angle evaluation in GRAVITY_Y
        if (pop.size() < populationSize) {
            pop.add(new Individual(adamOrder.clone(), canonicalRot.clone(), PlacementMode.GRAVITY_Y, true));
        }

        // Seed 2: complementary 0°/180° pair-interlocking lattice (for L-shapes, triangles, trapezoids, sleeves)
        if (pop.size() < populationSize && n > 1) {
            int[] pairRot = buildComplementaryRotations(adamOrder, 0, 180);
            pop.add(new Individual(adamOrder.clone(), pairRot, PlacementMode.GRAVITY_Y, false));
        }

        // Seed 3: decreasing feed-direction height with greedy multi-angle evaluation
        if (pop.size() < populationSize && n > 1) {
            Integer[] byHeightDesc = byAreaDesc.clone();
            Arrays.sort(byHeightDesc, Comparator
                    .comparingDouble((Integer idx) -> items.get(idx).primaryHeight()).reversed()
                    .thenComparing(Comparator.comparingDouble((Integer idx) -> items.get(idx).area()).reversed())
                    .thenComparingInt(Integer::intValue));
            int[] hOrder = toPrimitive(byHeightDesc);
            int[] hRot = buildComplementaryRotations(hOrder, 0, 180);
            pop.add(new Individual(hOrder, hRot, PlacementMode.GRAVITY_Y, true));
        }

        // Seed 4: Deepnest 'box' mode with greedy angles (excels on finite & concave sheets)
        if (pop.size() < populationSize && n > 1) {
            pop.add(new Individual(adamOrder.clone(), canonicalRot.clone(), PlacementMode.BOX_AREA, true));
        }

        // Seed 5: TIGHT_CORNER mode with complementary rotations (excels on multi-shape concave pockets)
        if (pop.size() < populationSize && n > 1) {
            int[] pairRot90 = buildComplementaryRotations(adamOrder, 90, 270);
            pop.add(new Individual(adamOrder.clone(), pairRot90, PlacementMode.TIGHT_CORNER, true));
        }

        // Remaining individuals: mutated clones of Adam with randomized orientations and placement modes
        int[] randomRot = new int[n];
        for (int i = 0; i < n; i++) {
            List<Integer> angles = items.get(adamOrder[i]).allowedAngles();
            randomRot[i] = angles.get(rng.nextInt(angles.size()));
        }
        Individual adamRandom = new Individual(adamOrder.clone(), randomRot, PlacementMode.GRAVITY_Y, false);
        while (pop.size() < populationSize) {
            ComputationCancellation.check();
            pop.add(mutate(pop.size() % 2 == 0 ? adamRandom : pop.get(2 % pop.size())));
        }

        return pop;
    }

    private int[] buildComplementaryRotations(int[] order, int angleA, int angleB) {
        int n = order.length;
        int[] rot = new int[n];
        Map<Integer, Integer> seenPerDemand = new HashMap<>();
        for (int i = 0; i < n; i++) {
            PartDescriptor pd = items.get(order[i]);
            int occ = seenPerDemand.merge(pd.demandId(), 1, Integer::sum) - 1;
            List<Integer> allowed = pd.allowedAngles();
            int target = (occ % 2 == 0) ? angleA : angleB;
            if (allowed.contains(target)) {
                rot[i] = target;
            } else {
                rot[i] = allowed.get(occ % allowed.size());
            }
        }
        return rot;
    }

    /**
     * Mutates insertion order, part orientations, and occasionally placement mode,
     * migrated from {@code GeneticAlgorithm.prototype.mutate} ({@code deepnest.js:1349-1371}).
     */
    Individual mutate(Individual individual) {
        int n = individual.order.length;
        int[] order = individual.order.clone();
        int[] rot = individual.rotations.clone();
        double prob = 0.01 * mutationRate;

        for (int i = 0; i < n; i++) {
            if (n > 1 && rng.nextDouble() < prob) {
                int j = i + 1 < n ? i + 1 : 0;
                swap(order, rot, i, j);
            }
            if (n > 3 && rng.nextDouble() < prob * 0.35) {
                int j = rng.nextInt(n);
                swap(order, rot, i, j);
            }
            if (rng.nextDouble() < prob) {
                List<Integer> allowed = items.get(order[i]).allowedAngles();
                if (allowed.size() > 1) {
                    rot[i] = allowed.get(rng.nextInt(allowed.size()));
                }
            }
        }

        PlacementMode mode = individual.placementMode;
        if (rng.nextDouble() < 0.15) {
            mode = MODES[rng.nextInt(MODES.length)];
        }
        return new Individual(order, rot, mode, false);
    }

    /** Injects fresh diversified individuals while keeping the top elites when stagnating on an incomplete kit. */
    void diversifyPopulation() {
        ComputationCancellation.check();
        population.sort(Comparator.comparingDouble(ind -> ind.fitness));
        List<Individual> nextPop = new ArrayList<>(population.size());
        // Keep top 2 elites
        nextPop.add(population.get(0));
        if (population.size() > 1) {
            nextPop.add(mutate(population.get(0)));
        }
        int n = items.size();
        while (nextPop.size() < population.size()) {
            ComputationCancellation.check();
            int[] perm = population.get(0).order.clone();
            int[] rot = new int[n];
            // Fisher-Yates partial shuffle biasing larger pieces slightly earlier while exploring new sequences
            for (int i = n - 1; i > 0; i--) {
                if (rng.nextDouble() < 0.65) {
                    int j = rng.nextInt(i + 1);
                    int tmp = perm[i];
                    perm[i] = perm[j];
                    perm[j] = tmp;
                }
            }
            for (int i = 0; i < n; i++) {
                List<Integer> allowed = items.get(perm[i]).allowedAngles();
                rot[i] = allowed.get(rng.nextInt(allowed.size()));
            }
            PlacementMode mode = MODES[nextPop.size() % MODES.length];
            boolean greedy = (nextPop.size() % 3 == 0);
            nextPop.add(new Individual(perm, rot, mode, greedy));
        }
        this.population = nextPop;
    }

    /**
     * Single-point Order Crossover (OX1) preserving gene uniqueness and parent rotations,
     * migrated from {@code GeneticAlgorithm.prototype.mate} ({@code deepnest.js:1374-1409}).
     */
    Individual[] mate(Individual male, Individual female) {
        int n = male.order.length;
        if (n <= 1) {
            return new Individual[]{
                    new Individual(male.order.clone(), male.rotations.clone(), male.placementMode, false),
                    new Individual(female.order.clone(), female.rotations.clone(), female.placementMode, false)
            };
        }

        double ratio = Math.min(Math.max(rng.nextDouble(), 0.1), 0.9);
        int cutpoint = Math.max(1, Math.min(n - 1, (int) Math.round(ratio * (n - 1))));

        Individual child1 = buildOffspring(male, female, cutpoint, items.size());
        Individual child2 = buildOffspring(female, male, cutpoint, items.size());
        return new Individual[]{child1, child2};
    }

    private static Individual buildOffspring(Individual primary, Individual secondary, int cutpoint, int totalItems) {
        int n = primary.order.length;
        int[] gene = new int[n];
        int[] rot = new int[n];
        boolean[] used = new boolean[totalItems];

        int pos = 0;
        for (int i = 0; i < cutpoint; i++) {
            int id = primary.order[i];
            gene[pos] = id;
            rot[pos] = primary.rotations[i];
            used[id] = true;
            pos++;
        }
        for (int i = 0; i < n && pos < n; i++) {
            int id = secondary.order[i];
            if (!used[id]) {
                gene[pos] = id;
                rot[pos] = secondary.rotations[i];
                used[id] = true;
                pos++;
            }
        }
        return new Individual(gene, rot, primary.placementMode, false);
    }

    /**
     * Advances to the next generation using elitism and linear-rank weighted parent selection,
     * migrated from {@code GeneticAlgorithm.prototype.generation} ({@code deepnest.js:1411-1463}).
     */
    void nextGeneration() {
        ComputationCancellation.check();
        population.sort(Comparator.comparingDouble(ind -> ind.fitness));

        List<Individual> nextPop = new ArrayList<>(population.size());
        nextPop.add(population.get(0));

        while (nextPop.size() < population.size()) {
            ComputationCancellation.check();
            Individual male = randomWeightedIndividual(null);
            Individual female = randomWeightedIndividual(male);
            Individual[] children = mate(male, female);

            nextPop.add(mutate(children[0]));
            if (nextPop.size() < population.size()) {
                nextPop.add(mutate(children[1]));
            }
        }
        this.population = nextPop;
    }

    private Individual randomWeightedIndividual(Individual exclude) {
        List<Individual> pool = new ArrayList<>(population.size());
        for (Individual ind : population) {
            if (ind != exclude) pool.add(ind);
        }
        if (pool.isEmpty()) return population.get(0);

        double rand = rng.nextDouble();
        double lower = 0.0;
        double weight = 1.0 / pool.size();
        double upper = weight;

        for (int i = 0; i < pool.size(); i++) {
            if (rand >= lower && rand < upper) {
                return pool.get(i);
            }
            lower = upper;
            upper += 2.0 * weight * ((double) (pool.size() - i) / pool.size());
        }
        return pool.get(0);
    }

    private static void swap(int[] order, int[] rot, int i, int j) {
        if (i == j) return;
        int tmpO = order[i];
        order[i] = order[j];
        order[j] = tmpO;
        int tmpR = rot[i];
        rot[i] = rot[j];
        rot[j] = tmpR;
    }

    private static int[] toPrimitive(Integer[] arr) {
        int[] res = new int[arr.length];
        for (int i = 0; i < arr.length; i++) res[i] = arr[i];
        return res;
    }
}
