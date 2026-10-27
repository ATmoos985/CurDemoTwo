#!/usr/bin/env bash
set -euo pipefail

# Use the same upstream revision and solver options as the Linux image.
root=$(cd "$(dirname "$0")/.." && pwd)
revision=$(sed -n 's/^ARG PACKINGSOLVER_REVISION=//p' "$root/Dockerfile")
[[ $(uname -s) == Darwin ]] || { echo 'This script requires macOS.' >&2; exit 1; }
[[ $revision =~ ^[0-9a-f]{40}$ ]] || { echo 'Missing pinned revision in Dockerfile.' >&2; exit 1; }
for tool in git cmake clang++; do
    command -v "$tool" >/dev/null || { echo "Missing $tool. Install Xcode Command Line Tools and CMake (brew install cmake)." >&2; exit 1; }
done

source_dir="$root/data/solver-build/packingsolver"
build_dir="$source_dir/build-macos"
destination="$root/data/solver"
if [[ ! -d "$source_dir" ]]; then
    mkdir -p "$source_dir"
    git -C "$source_dir" init
    git -C "$source_dir" remote add origin https://github.com/fontanf/packingsolver.git
fi
[[ $(git -C "$source_dir" remote get-url origin) == https://github.com/fontanf/packingsolver.git ]] || {
    echo "Unexpected source repository: $source_dir" >&2; exit 1;
}
[[ -z $(git -C "$source_dir" status --porcelain --untracked-files=no) ]] || {
    echo "Source has local changes; preserve them before rebuilding: $source_dir" >&2; exit 1;
}
if [[ $(git -C "$source_dir" rev-parse --verify HEAD 2>/dev/null || true) != "$revision" ]]; then
    git -C "$source_dir" fetch --depth 1 origin "$revision"
    git -C "$source_dir" checkout --detach FETCH_HEAD
fi

cmake -S "$source_dir" -B "$build_dir" -DCMAKE_BUILD_TYPE=Release \
    -DPACKINGSOLVER_BUILD_TEST=OFF -DPACKINGSOLVER_USE_CLP=OFF
cmake --build "$build_dir" --target PackingSolver_rectangleguillotine_main PackingSolver_irregular_main \
    --parallel "${SOLVER_BUILD_JOBS:-2}"

# Keep the application's existing default filenames. The contents are macOS
# Mach-O executables; the .exe suffix does not make them Windows programs.
# Validate both before installing either. Never overwrite a different bundle.
smoke=$(mktemp -d "$build_dir/smoke.XXXXXX")
printf 'ID,WIDTH,HEIGHT\n0,1000,1000\n' > "$smoke/bins.csv"
printf 'ID,WIDTH,HEIGHT,COPIES\n0,100,100,1\n' > "$smoke/items.csv"
cat > "$smoke/input.json" <<'JSON'
{"objective":"knapsack","bin_types":[{"type":"polygon","vertices":[{"x":0,"y":0},{"x":1000,"y":0},{"x":1000,"y":1000},{"x":0,"y":1000}],"copies":1}],"item_types":[{"type":"polygon","vertices":[{"x":0,"y":0},{"x":100,"y":0},{"x":100,"y":100},{"x":0,"y":100}],"copies":1,"profit":10000,"allowed_rotations":[{"start":0,"end":0,"mirror":false}]}]}
JSON
"$build_dir/src/rectangleguillotine/packingsolver_rectangleguillotine" \
    --items "$smoke/items.csv" --bins "$smoke/bins.csv" --objective knapsack \
    --certificate "$smoke/rectangle.csv" --time-limit 1 --verbosity-level 0 --only-write-at-the-end
"$build_dir/src/irregular/packingsolver_irregular" --input "$smoke/input.json" \
    --certificate "$smoke/irregular.json" --time-limit 1 --verbosity-level 0 --only-write-at-the-end
[[ -s "$smoke/rectangle.csv" && -s "$smoke/irregular.json" ]] || {
    echo "Native solver smoke check produced no certificate: $smoke" >&2; exit 1;
}
for engine in rectangleguillotine irregular; do
    executable="$build_dir/src/$engine/packingsolver_$engine"
    target="$destination/packingsolver_$engine.exe"
    if [[ -e "$target" ]] && ! cmp -s "$executable" "$target"; then
        echo "Different executable already exists; preserve it before installing: $target" >&2
        exit 1
    fi
done
mkdir -p "$destination/licenses"
for engine in rectangleguillotine irregular; do
    target="$destination/packingsolver_$engine.exe"
    if [[ ! -e "$target" ]]; then
        install -m 755 "$build_dir/src/$engine/packingsolver_$engine" "$target"
    fi
done
cp "$source_dir/LICENSE" "$destination/licenses/LICENSE-packingsolver"
while IFS= read -r -d '' license; do
    relative=${license#"$build_dir/_deps/"}
    mkdir -p "$destination/licenses/$(dirname "$relative")"
    cp "$license" "$destination/licenses/$relative"
done < <(find "$build_dir/_deps" -maxdepth 2 -type f \( -iname 'license*' -o -iname 'copying*' -o -iname 'copyright*' \) -print0)
printf 'Installed macOS solvers (%s) in %s\n' "$revision" "$destination"
echo 'Start the application from the repository root, then verify /api/health and a real solve for each engine.'
