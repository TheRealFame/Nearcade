#include <openvr_driver.h>
#include <thread>
#include <atomic>
#include <vector>
#include <cstring>
#include <iostream>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#pragma comment(lib, "ws2_32.lib")
#else
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
#endif

using namespace vr;

// Binary packet structure matching backend_vr.py
#pragma pack(push, 1)
struct NearsecVRPacket {
    uint32_t seq;
    float head_qx, head_qy, head_qz, head_qw, head_px, head_py, head_pz;
    float left_qx, left_qy, left_qz, left_qw, left_px, left_py, left_pz;
    float right_qx, right_qy, right_qz, right_qw, right_px, right_py, right_pz;
    uint8_t btn_l, btn_r, trig_l, trig_r, grip_l, grip_r;
};
#pragma pack(pop)

class SteamVRNearsecDriver : public vr::ITrackedDeviceServerDriver {
public:
    virtual vr::EVRInitError Activate(uint32_t unObjectId) override {
        m_unObjectId = unObjectId;
        m_ulPropertyContainer = vr::VRProperties()->TrackedDeviceToPropertyContainer(m_unObjectId);

        vr::VRProperties()->SetStringProperty(m_ulPropertyContainer, vr::Prop_ModelNumber_String, "NearsecVR_HMD");
        vr::VRProperties()->SetStringProperty(m_ulPropertyContainer, vr::Prop_RenderModelName_String, "generic_hmd");

        // Start UDP Listener Thread
        m_bIsRunning = true;
        m_pUdpThread = new std::thread(&SteamVRNearsecDriver::UdpListenerThread, this);

        return vr::VRInitError_None;
    }

    virtual void Deactivate() override {
        m_bIsRunning = false;
        if (m_pUdpThread) {
            m_pUdpThread->join();
            delete m_pUdpThread;
            m_pUdpThread = nullptr;
        }
        m_unObjectId = vr::k_unTrackedDeviceIndexInvalid;
    }

    virtual void EnterStandby() override {}
    virtual void* GetComponent(const char* pchComponentNameAndVersion) override { return nullptr; }
    virtual void DebugRequest(const char* pchRequest, char* pchResponseBuffer, uint32_t unResponseBufferSize) override {}

    virtual vr::DriverPose_t GetPose() override {
        vr::DriverPose_t pose = { 0 };
        pose.poseIsValid = true;
        pose.result = vr::TrackingResult_Running_OK;
        pose.deviceIsConnected = true;

        pose.qWorldFromDriverRotation = { 1, 0, 0, 0 };
        pose.qDriverFromHeadRotation = { 1, 0, 0, 0 };
        
        // Apply latest UDP state
        pose.qRotation.x = m_latestState.head_qx;
        pose.qRotation.y = m_latestState.head_qy;
        pose.qRotation.z = m_latestState.head_qz;
        pose.qRotation.w = m_latestState.head_qw;
        
        pose.vecPosition[0] = m_latestState.head_px;
        pose.vecPosition[1] = m_latestState.head_py;
        pose.vecPosition[2] = m_latestState.head_pz;

        return pose;
    }

private:
    void UdpListenerThread() {
#ifdef _WIN32
        WSADATA wsaData;
        WSAStartup(MAKEWORD(2, 2), &wsaData);
#endif
        int sock = socket(AF_INET, SOCK_DGRAM, 0);
        sockaddr_in serverAddr;
        serverAddr.sin_family = AF_INET;
        serverAddr.sin_port = htons(27015);
        serverAddr.sin_addr.s_addr = INADDR_ANY;

        bind(sock, (struct sockaddr*)&serverAddr, sizeof(serverAddr));

        while (m_bIsRunning) {
            NearsecVRPacket packet;
            int bytesReceived = recv(sock, (char*)&packet, sizeof(packet), 0);
            if (bytesReceived == sizeof(NearsecVRPacket)) {
                m_latestState = packet;
                if (m_unObjectId != vr::k_unTrackedDeviceIndexInvalid) {
                    vr::VRServerDriverHost()->TrackedDevicePoseUpdated(m_unObjectId, GetPose(), sizeof(vr::DriverPose_t));
                }
            }
        }
#ifdef _WIN32
        closesocket(sock);
        WSACleanup();
#else
        close(sock);
#endif
    }

    vr::TrackedDeviceIndex_t m_unObjectId = vr::k_unTrackedDeviceIndexInvalid;
    vr::PropertyContainerHandle_t m_ulPropertyContainer = vr::k_ulInvalidPropertyContainer;
    std::thread* m_pUdpThread = nullptr;
    std::atomic<bool> m_bIsRunning{false};
    NearsecVRPacket m_latestState = {0};
};

class NearsecServerProvider : public vr::IServerTrackedDeviceProvider {
public:
    virtual vr::EVRInitError Init(vr::IVRDriverContext* pDriverContext) override {
        VR_INIT_SERVER_DRIVER_CONTEXT(pDriverContext);
        m_pHmd = new SteamVRNearsecDriver();
        vr::VRServerDriverHost()->TrackedDeviceAdded("nearsec_vrmd_1", vr::TrackedDeviceClass_HMD, m_pHmd);
        return vr::VRInitError_None;
    }

    virtual void Cleanup() override {
        if (m_pHmd) {
            delete m_pHmd;
            m_pHmd = nullptr;
        }
        VR_CLEANUP_SERVER_DRIVER_CONTEXT();
    }

    virtual const char* const* GetInterfaceVersions() override {
        return vr::k_InterfaceVersions;
    }

    virtual void RunFrame() override {}
    virtual bool ShouldBlockStandbyMode() override { return false; }
    virtual void EnterStandby() override {}
    virtual void LeaveStandby() override {}

private:
    SteamVRNearsecDriver* m_pHmd = nullptr;
};

NearsecServerProvider g_serverDriverProvider;

// Entry point required by SteamVR
#if defined(_WIN32)
#define HMD_DLL_EXPORT extern "C" __declspec(dllexport)
#else
#define HMD_DLL_EXPORT extern "C" __attribute__((visibility("default")))
#endif

HMD_DLL_EXPORT void* HmdDriverFactory(const char* pInterfaceName, int* pReturnCode) {
    if (0 == strcmp(vr::IServerTrackedDeviceProvider_Version, pInterfaceName)) {
        return &g_serverDriverProvider;
    }
    if (pReturnCode) *pReturnCode = vr::VRInitError_Init_InterfaceNotFound;
    return nullptr;
}
