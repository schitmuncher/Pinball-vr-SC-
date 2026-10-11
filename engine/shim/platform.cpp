// Web host for the Space Cadet engine: replaces winmain.cpp, the Android JNI glue and the SDL
// back end. The browser drives the frame loop and reads the composed table back for 3D rendering.
#include "pch.h"

#define private public
#include "winmain.h"
#include "render.h"
#include "zdrv.h"
#include "proj.h"
#undef private

#include "control.h"
#include "fullscrn.h"
#include "midi.h"
#include "options.h"
#include "pb.h"
#include "pinball.h"
#include "Sound.h"
#include "TBall.h"
#include "TPinballTable.h"

#define IMPORT(name) __attribute__((import_module("host"), import_name(#name)))
#define EXPORT(name) __attribute__((export_name(#name)))

extern "C" {
IMPORT(now_ms) double host_now_ms();
IMPORT(log) void host_log(const char* msg, int len);
IMPORT(load_sound) int host_load_sound(const char* path, int len);
IMPORT(play_sound) void host_play_sound(int id);
IMPORT(stop_sounds) void host_stop_sounds();
IMPORT(sound_volume) void host_sound_volume(int vol);
IMPORT(load_music) int host_load_music(const char* path, int len);
IMPORT(load_music_mem) int host_load_music_mem(const void* data, int len);
IMPORT(play_music) void host_play_music(int id);
IMPORT(stop_music) void host_stop_music();
IMPORT(music_volume) void host_music_volume(int vol);
IMPORT(event) void host_event(int kind, int value);
IMPORT(text) void host_text(const char* text, int len, int type);
IMPORT(get_high_score) int host_get_high_score();
}

static void log_str(const std::string& s) { host_log(s.data(), static_cast<int>(s.size())); }

// ---------------------------------------------------------------- SDL back end
struct SDL_Texture { std::vector<uint32_t> pixels; int w = 0, h = 0; };
struct SDL_RWops { std::vector<char> data; };

void SDL_GetRendererOutputSize(SDL_Renderer*, int* w, int* h) { *w = 1200; *h = 832; }

SDL_Texture* SDL_CreateTexture(SDL_Renderer*, Uint32, int access, int w, int h)
{
	auto tex = new SDL_Texture();
	tex->w = w;
	tex->h = h;
	if (access == SDL_TEXTUREACCESS_STREAMING)
		tex->pixels.resize(static_cast<size_t>(w) * h);
	return tex;
}

int SDL_LockTexture(SDL_Texture* tex, const SDL_Rect*, void** pixels, int* pitch)
{
	*pixels = tex->pixels.data();
	*pitch = tex->w * 4;
	return 0;
}

SDL_RWops* SDL_RWFromMem(void* mem, int size)
{
	auto rw = new SDL_RWops();
	rw->data.assign(static_cast<char*>(mem), static_cast<char*>(mem) + size);
	return rw;
}

Uint32 SDL_GetTicks() { return static_cast<Uint32>(host_now_ms()); }
Uint64 SDL_GetPerformanceCounter() { return static_cast<Uint64>(host_now_ms() * 1000.0); }
Uint64 SDL_GetPerformanceFrequency() { return 1000000; }

int Mix_Init(int flags) { return flags; }
int Mix_Volume(int, int volume) { host_sound_volume(volume); return volume; }
int Mix_VolumeMusic(int volume) { host_music_volume(volume); return volume; }
int Mix_HaltChannel(int) { host_stop_sounds(); return 0; }
int Mix_PlayChannel(int, Mix_Chunk* chunk, int)
{
	if (!chunk) return -1;
	host_play_sound(chunk->id);
	return 0;
}

Mix_Chunk* Mix_LoadWAV(const char* file)
{
	int id = host_load_sound(file, static_cast<int>(strlen(file)));
	if (id < 0) return nullptr;
	return new Mix_Chunk{id};
}

void Mix_FreeChunk(Mix_Chunk* chunk) { delete chunk; }

Mix_Music* Mix_LoadMUS(const char* file)
{
	int id = host_load_music(file, static_cast<int>(strlen(file)));
	if (id < 0) return nullptr;
	return new Mix_Music{id};
}

Mix_Music* Mix_LoadMUS_RW(SDL_RWops* src, int)
{
	if (!src) return nullptr;
	int id = host_load_music_mem(src->data.data(), static_cast<int>(src->data.size()));
	delete src;
	if (id < 0) return nullptr;
	return new Mix_Music{id};
}

void Mix_FreeMusic(Mix_Music* music) { delete music; }
int Mix_PlayMusic(Mix_Music* music, int)
{
	if (!music) return -1;
	host_play_music(music->id);
	return 0;
}
int Mix_HaltMusic() { host_stop_music(); return 0; }

// ---------------------------------------------------------------- Android JNI replacement
enum HostEvent
{
	EvReady = 1, EvGameState, EvBallInPlunger, EvHighScore, EvScore, EvBallCount, EvRemainingBalls, EvCheats,
	EvClearText
};

void SpaceCadetPinballJNI::show_error_dialog(std::string title, std::string message)
{
	log_str("ERROR: " + title + ": " + message);
}
void SpaceCadetPinballJNI::notifyGameState(int state) { host_event(EvGameState, state); }
void SpaceCadetPinballJNI::setBallInPlunger(bool state) { host_event(EvBallInPlunger, state ? 1 : 0); }
void SpaceCadetPinballJNI::addHighScore(int score) { host_event(EvHighScore, score); }
int SpaceCadetPinballJNI::getHighScore() { return host_get_high_score(); }
void SpaceCadetPinballJNI::displayText(const char* text, int type)
{
	host_text(text, text ? static_cast<int>(strlen(text)) : 0, type);
}
void SpaceCadetPinballJNI::clearText(int type) { host_event(EvClearText, type); }
void SpaceCadetPinballJNI::postScore(int score) { host_event(EvScore, score); }
void SpaceCadetPinballJNI::postBallCount(int count) { host_event(EvBallCount, count); }
void SpaceCadetPinballJNI::cheatsUsed() { host_event(EvCheats, 1); }
void SpaceCadetPinballJNI::gameReady() { host_event(EvReady, 1); }
void SpaceCadetPinballJNI::postRemainingBalls(int balls) { host_event(EvRemainingBalls, balls); }

// ---------------------------------------------------------------- winmain replacement
SDL_Window* winmain::MainWindow = nullptr;
SDL_Renderer* winmain::Renderer = nullptr;
int winmain::return_value = 0;
bool winmain::bQuit = false;
bool winmain::activated = true;
int winmain::DispFrameRate = 0;
int winmain::DispGRhistory = 0;
bool winmain::single_step = false;
bool winmain::has_focus = true;
int winmain::last_mouse_x;
int winmain::last_mouse_y;
int winmain::mouse_down;
bool winmain::no_time_loss = false;
bool winmain::restart = false;
gdrv_bitmap8* winmain::gfr_display = nullptr;
std::string winmain::DatFileName;
bool winmain::ShowAboutDialog = false;
bool winmain::ShowImGuiDemo = false;
bool winmain::ShowSpriteViewer = false;
bool winmain::LaunchBallEnabled = true;
bool winmain::HighScoresEnabled = true;
bool winmain::DemoActive = false;
char* winmain::BasePath = const_cast<char*>("/");
int winmain::MainMenuHeight = 0;
std::string winmain::FpsDetails;
double winmain::UpdateToFrameRatio;
winmain::DurationMs winmain::TargetFrameTime;
optionsStruct& winmain::Options = options::Options;

int winmain::WinMain(LPCSTR) { return 0; }
int winmain::event_handler(const SDL_Event*) { return 1; }
void winmain::memalloc_failure()
{
	log_str("Out of memory");
	std::abort();
}
int winmain::ProcessWindowMessages() { return 1; }
void winmain::a_dialog() {}
void winmain::end_pause()
{
	if (single_step)
	{
		pb::pause_continue();
		no_time_loss = true;
	}
}
void winmain::new_game()
{
	end_pause();
	pb::replay_level(false);
}
void winmain::pause(bool toggle)
{
	if (toggle || !single_step)
	{
		pb::pause_continue();
		no_time_loss = true;
	}
}
void winmain::Restart() {}
void winmain::UpdateFrameRate()
{
	auto fps = Options.FramesPerSecond, ups = Options.UpdatesPerSecond;
	UpdateToFrameRatio = static_cast<double>(ups) / fps;
	TargetFrameTime = DurationMs(1000.0 / ups);
}
void winmain::RenderUi() {}

// ---------------------------------------------------------------- exports for the 3D host
static float g_info[32];
static float g_balls[64];

extern "C" {

EXPORT(scp_init) int scp_init(int playMusic)
{
	static SDL_Renderer* fakeRenderer = reinterpret_cast<SDL_Renderer*>(1);
	static SDL_Window* fakeWindow = reinterpret_cast<SDL_Window*>(1);
	winmain::Renderer = fakeRenderer;
	winmain::MainWindow = fakeWindow;

	SpaceCadetPinballJNI::gameReady();
	winmain::DatFileName = options::get_string("Pinball Data", pinball::get_rc_string(168, 0));

	if (auto cadet = fopen(pinball::make_path_name("CADET.DAT").c_str(), "rb"))
	{
		fclose(cadet);
		winmain::DatFileName = "CADET.DAT";
		pb::FullTiltMode = true;
	}

	options::init();
	if (!Sound::Init(winmain::Options.SoundChannels, winmain::Options.Sounds, winmain::Options.SoundVolume))
		winmain::Options.Sounds = false;
	winmain::Options.Music = playMusic != 0;
	if (winmain::Options.Music && !midi::music_init(winmain::Options.MusicVolume))
		winmain::Options.Music = false;

	if (pb::init())
	{
		SpaceCadetPinballJNI::show_error_dialog("Could not load game data", "The .dat file is missing");
		return 1;
	}
	fullscrn::init();
	pb::reset_table();
	pb::firsttime_setup();
	pb::replay_level(false);
	return 0;
}

EXPORT(scp_frame) void scp_frame(float dtMs)
{
	if (winmain::single_step)
		return;
	if (winmain::no_time_loss)
	{
		winmain::no_time_loss = false;
		return;
	}
	pb::frame(dtMs);
}

// type: 0 keyboard, 1 mouse, 2 controller (matches InputTypes)
EXPORT(scp_input) void scp_input(int type, int value, int down)
{
	GameInput input{static_cast<InputTypes>(type), value};
	if (down) pb::InputDown(input);
	else pb::InputUp(input);
}

EXPORT(scp_new_game) void scp_new_game() { winmain::new_game(); }
EXPORT(scp_pause) void scp_pause() { winmain::pause(); }
EXPORT(scp_is_paused) int scp_is_paused() { return winmain::single_step ? 1 : 0; }
EXPORT(scp_demo) void scp_demo() { pb::toggle_demo(); }
EXPORT(scp_set_players) void scp_set_players(int n)
{
	winmain::Options.Players = Clamp(n, 1, 4);
	winmain::new_game();
}
EXPORT(scp_set_music) void scp_set_music(int on)
{
	winmain::Options.Music = on != 0;
	if (on) midi::play_pb_theme();
	else midi::music_stop();
}
EXPORT(scp_set_sounds) void scp_set_sounds(int on) { Sound::Enable(on != 0); winmain::Options.Sounds = on != 0; }

EXPORT(scp_vscreen) void* scp_vscreen() { return render::vscreen->BmpBufPtr1; }
EXPORT(scp_vscreen_stride) int scp_vscreen_stride() { return render::vscreen->Stride; }
EXPORT(scp_zscreen) void* scp_zscreen() { return render::zscreen->ZPtr1; }
EXPORT(scp_zscreen_stride) int scp_zscreen_stride() { return render::zscreen->Stride; }
EXPORT(scp_bgz) void* scp_bgz() { return render::background_zmap ? render::background_zmap->ZPtr1 : nullptr; }

// Layout of scp_info(): [0..11] camera 4x3 row major, 12 d, 13 cx, 14 cy, 15 zmin, 16 zscaler,
// 17 width, 18 height, 19 bgz width, 20 bgz height, 21 bgz stride, 22 bgz offset x, 23 bgz offset y,
// 24 full tilt flag, 25 ball radius
EXPORT(scp_info) float* scp_info()
{
	memcpy(g_info, &proj::matrix, sizeof(float) * 12);
	g_info[12] = proj::d_;
	g_info[13] = proj::centerx;
	g_info[14] = proj::centery;
	g_info[15] = render::zmin;
	g_info[16] = render::zscaler;
	g_info[17] = static_cast<float>(render::vscreen->Width);
	g_info[18] = static_cast<float>(render::vscreen->Height);
	auto bgz = render::background_zmap;
	g_info[19] = bgz ? static_cast<float>(bgz->Width) : 0;
	g_info[20] = bgz ? static_cast<float>(bgz->Height) : 0;
	g_info[21] = bgz ? static_cast<float>(bgz->Stride) : 0;
	g_info[22] = static_cast<float>(render::zmap_offset);
	g_info[23] = static_cast<float>(render::zmap_offsetY);
	g_info[24] = pb::FullTiltMode ? 1.f : 0.f;
	g_info[25] = pb::MainTable && !pb::MainTable->BallList.empty() ? pb::MainTable->BallList[0]->Offset : 0.f;
	return g_info;
}

// Balls: count, then per ball x, y, z, visible
EXPORT(scp_balls) float* scp_balls()
{
	int n = 0;
	if (pb::MainTable)
	{
		for (auto ball : pb::MainTable->BallList)
		{
			if (n >= 15) break;
			auto* out = &g_balls[1 + n * 4];
			out[0] = ball->Position.X;
			out[1] = ball->Position.Y;
			out[2] = ball->Position.Z;
			out[3] = (ball->ActiveFlag && ball->RenderSprite && ball->RenderSprite->Bmp) ? 1.f : 0.f;
			n++;
		}
	}
	g_balls[0] = static_cast<float>(n);
	return g_balls;
}

// When set, balls are not painted into the 2D framebuffer; the host draws real spheres instead.
EXPORT(scp_hide_2d_balls) void scp_hide_2d_balls(int hide);
}

bool g_hide2dBalls = false;
void scp_hide_2d_balls(int hide) { g_hide2dBalls = hide != 0; }

extern "C" EXPORT(scp_debug) float* scp_debug()
{
	static float d[8];
	d[0] = pb::time_now;
	d[1] = static_cast<float>(pb::game_mode);
	d[2] = winmain::single_step;
	d[3] = pb::MainTable ? static_cast<float>(pb::MainTable->BallList.size()) : -1;
	d[4] = 0;
	d[5] = pb::MainTable ? pb::MainTable->BallList[0]->ActiveFlag : -1;
	return d;
}
