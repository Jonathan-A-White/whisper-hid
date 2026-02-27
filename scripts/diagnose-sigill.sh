#!/data/data/com.termux/files/usr/bin/bash
# diagnose-sigill.sh — Collect diagnostic info for SIGILL crashes in whisper-cli
# Run from the phone: bash scripts/diagnose-sigill.sh
set -uo pipefail

INSTALL_DIR="$HOME/whisper-stt"
WHISPER_BIN="$INSTALL_DIR/whisper.cpp/build/bin/whisper-cli"
[ ! -x "$WHISPER_BIN" ] && WHISPER_BIN="$INSTALL_DIR/whisper.cpp/build/bin/main"
MODEL="${WHISPER_MODEL:-$INSTALL_DIR/models/ggml-base.en.bin}"
BUILD_DIR="$INSTALL_DIR/whisper.cpp/build"

echo "=== SIGILL Diagnostic Report ==="
echo "Date: $(date)"
echo ""

# 1. CPU info
echo "--- /proc/cpuinfo (first CPU) ---"
head -30 /proc/cpuinfo 2>/dev/null || echo "(not available)"
echo ""

echo "--- CPU Features line ---"
grep -i "^Features" /proc/cpuinfo 2>/dev/null | head -1 || echo "(not found)"
echo ""

# 2. Binary info
echo "--- whisper-cli binary ---"
echo "Path: $WHISPER_BIN"
file "$WHISPER_BIN" 2>/dev/null || echo "(file command unavailable)"
echo ""

echo "--- ELF build attributes (readelf -A) ---"
if command -v readelf &>/dev/null; then
    readelf -A "$WHISPER_BIN" 2>/dev/null | head -30 || echo "(no attributes)"
else
    echo "(readelf not installed — run: pkg install binutils)"
fi
echo ""

echo "--- Shared libraries ---"
ldd "$WHISPER_BIN" 2>/dev/null || echo "(ldd unavailable, trying readelf)"
readelf -d "$WHISPER_BIN" 2>/dev/null | grep NEEDED || true
echo ""

echo "--- libggml-cpu.so build attributes ---"
GGML_CPU_SO=$(find "$BUILD_DIR" -name "libggml-cpu*.so" 2>/dev/null | head -1)
if [ -n "$GGML_CPU_SO" ]; then
    echo "Path: $GGML_CPU_SO"
    if command -v readelf &>/dev/null; then
        readelf -A "$GGML_CPU_SO" 2>/dev/null | head -30 || echo "(no attributes)"
    fi
else
    echo "(not found)"
fi
echo ""

# 3. CMake cache — actual flags used
echo "--- CMake cache (key flags) ---"
CACHE="$BUILD_DIR/CMakeCache.txt"
if [ -f "$CACHE" ]; then
    grep -E "^(CMAKE_C_FLAGS|CMAKE_CXX_FLAGS|GGML_FLASH_ATTN|GGML_NATIVE|GGML_CPU)" "$CACHE" 2>/dev/null || true
else
    echo "(CMakeCache.txt not found)"
fi
echo ""

# 4. Check actual compile command used for ggml-cpu
echo "--- Compile commands for ggml-cpu (first entry) ---"
COMPILE_DB="$BUILD_DIR/compile_commands.json"
if [ -f "$COMPILE_DB" ]; then
    # Find the compile command for ggml-cpu.c to see actual flags
    grep -A2 '"ggml-cpu.c"' "$COMPILE_DB" 2>/dev/null | head -5 || \
    grep -A2 'ggml-cpu' "$COMPILE_DB" 2>/dev/null | head -10 || \
    echo "(no ggml-cpu entries)"
else
    echo "(compile_commands.json not found — rebuild with -DCMAKE_EXPORT_COMPILE_COMMANDS=ON)"
fi
echo ""

# 5. Generate a silent WAV and test whisper directly
echo "--- Direct whisper test ---"
AUDIO_DIR="$INSTALL_DIR/audio_tmp"
mkdir -p "$AUDIO_DIR"
TEST_WAV="$AUDIO_DIR/diag_silence.wav"

# Generate 1 second of silence at 16kHz 16-bit mono using ffmpeg
if command -v ffmpeg &>/dev/null; then
    ffmpeg -y -f lavfi -i anullsrc=r=16000:cl=mono -t 1 -c:a pcm_s16le "$TEST_WAV" \
        </dev/null >/dev/null 2>&1
fi

if [ -f "$TEST_WAV" ]; then
    echo "Testing: $WHISPER_BIN -m $MODEL -l en -ng -nfa --no-timestamps -f $TEST_WAV"
    # Run and capture both exit code and any crash info
    set +e
    "$WHISPER_BIN" -m "$MODEL" -l en -ng -nfa --no-timestamps -f "$TEST_WAV" \
        >"$AUDIO_DIR/diag_stdout.txt" 2>"$AUDIO_DIR/diag_stderr.txt"
    RC=$?
    set -e
    echo "Exit code: $RC"
    if [ $RC -eq 132 ]; then
        echo "** SIGILL confirmed (exit code 132 = 128 + signal 4) **"
    elif [ $RC -eq 139 ]; then
        echo "** SIGSEGV (exit code 139 = 128 + signal 11) **"
    elif [ $RC -eq 0 ]; then
        echo "** Whisper ran successfully! **"
    fi
    echo ""
    echo "stderr:"
    cat "$AUDIO_DIR/diag_stderr.txt" 2>/dev/null
    echo ""
    echo "stdout:"
    cat "$AUDIO_DIR/diag_stdout.txt" 2>/dev/null
    rm -f "$TEST_WAV" "$AUDIO_DIR/diag_stdout.txt" "$AUDIO_DIR/diag_stderr.txt"
else
    echo "(could not generate test WAV)"
fi
echo ""

# 6. Check if we can get crash address from dmesg or logcat
echo "--- Crash details (logcat, last SIGILL) ---"
if command -v logcat &>/dev/null; then
    logcat -d -t 20 2>/dev/null | grep -iE "sigill|illegal|whisper|signal 4" || echo "(nothing found)"
elif [ -r /proc/self/maps ]; then
    echo "(logcat unavailable — checking /proc/self/maps for library addresses)"
    grep -E "ggml|whisper" /proc/self/maps 2>/dev/null || echo "(no matches)"
fi
echo ""

# 7. Scan for potentially problematic instructions in the hot library
echo "--- Instruction scan (libggml-cpu.so) ---"
if [ -n "$GGML_CPU_SO" ] && command -v objdump &>/dev/null; then
    # Look for SVE, SME, or i8mm instructions that this CPU doesn't support
    echo "Checking for SVE instructions..."
    SVE_COUNT=$(objdump -d "$GGML_CPU_SO" 2>/dev/null | grep -cE '\b(ld1[bhwd]|st1[bhwd]|ptrue|whilelt|fmla\s+z|fmov\s+z|movprfx)\b' || echo 0)
    echo "  SVE-like mnemonics found: $SVE_COUNT"

    echo "Checking for i8mm instructions..."
    I8MM_COUNT=$(objdump -d "$GGML_CPU_SO" 2>/dev/null | grep -cE '\b(smmla|ummla|usmmla|sudot|usdot)\b' || echo 0)
    echo "  i8mm-like mnemonics found: $I8MM_COUNT"

    echo "Checking for SME instructions..."
    SME_COUNT=$(objdump -d "$GGML_CPU_SO" 2>/dev/null | grep -cE '\b(smstart|smstop|fmopa|fmops|addha|addva)\b' || echo 0)
    echo "  SME-like mnemonics found: $SME_COUNT"
else
    if ! command -v objdump &>/dev/null; then
        echo "(objdump not installed — run: pkg install binutils)"
    else
        echo "(libggml-cpu.so not found)"
    fi
fi
echo ""

echo "=== End of diagnostic report ==="
echo ""
echo "Copy-paste the full output above and share it for analysis."
