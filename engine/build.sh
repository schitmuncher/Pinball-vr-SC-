#!/bin/sh
# Builds the Space Cadet engine to WebAssembly with clang + the WASI sysroot.
set -e
cd "$(dirname "$0")"
SYSROOT=${WASI_SYSROOT:-$HOME/wasi/wasi-sysroot-25.0}
RT=${WASI_RT:-$HOME/wasi/libclang_rt.builtins-wasm32-wasi-25.0/libclang_rt.builtins-wasm32.a}
mkdir -p obj
FLAGS="--target=wasm32-wasip1 --sysroot=$SYSROOT -O2 -std=c++17 -fno-exceptions -D_WASI_EMULATED_SIGNAL -DNDEBUG -Ishim -Isrc -Wno-everything"
OBJS=""
TODO=""
for f in src/*.cpp shim/platform.cpp; do
  o=obj/$(basename "$f" .cpp).o
  if [ ! -f "$o" ] || [ "$f" -nt "$o" ] || [ shim/SDL.h -nt "$o" ] || [ shim/SDL_mixer.h -nt "$o" ]; then
    TODO="$TODO $f"
  fi
  OBJS="$OBJS $o"
done
export FLAGS
[ -n "$TODO" ] && echo $TODO | tr ' ' '\n' | xargs -P 2 -I{} sh -c 'clang++ $FLAGS -c {} -o obj/$(basename {} .cpp).o || exit 255'
clang++ --target=wasm32-wasip1 --sysroot=$SYSROOT -O2 -nodefaultlibs \
  $OBJS -lc++ -lc++abi -lc $RT -lwasi-emulated-signal \
  -Wl,--no-entry -Wl,--export=malloc -Wl,--export=free -Wl,--export=_initialize \
  -Wl,--allow-undefined-file=shim/imports.txt -Wl,-z,stack-size=1048576 -Wl,--initial-memory=67108864 -Wl,--max-memory=268435456 -Wl,--growable-table \
  -mexec-model=reactor -o ../engine.wasm
ls -la ../engine.wasm
