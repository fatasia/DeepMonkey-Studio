#pragma once
#include <E57SimpleData.h>
#include <array>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <stdexcept>
#include <string>
#include <vector>

namespace e57bridge {
inline void check(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
inline void text_json(std::ostream& stream,const std::string& text) {
  check(text.size()<=65536,"metadata-string-budget");stream<<'"';
  constexpr char hex[]="0123456789abcdef";
  for(unsigned char value:text){
    if(value=='"'||value=='\\')stream<<'\\'<<char(value);
    else if(value<32)stream<<"\\u00"<<hex[value>>4]<<hex[value&15];
    else stream<<char(value);
  }
  stream<<'"';
}

struct Attributes {
  std::vector<uint16_t> red, green, blue;
  std::vector<double> intensity;
  std::vector<int8_t> invalidColor, invalidIntensity;
  bool hasColor = false, hasIntensity = false;
  explicit Attributes(size_t size): red(size), green(size), blue(size), intensity(size), invalidColor(size), invalidIntensity(size) {}
  void bind(const e57::PointStandardizedFieldsAvailable& fields, e57::Data3DPointsDouble& buffers) {
    hasColor = fields.colorRedField && fields.colorGreenField && fields.colorBlueField;
    check(hasColor || !(fields.colorRedField || fields.colorGreenField || fields.colorBlueField), "partial-rgb-fields");
    hasIntensity = fields.intensityField;
    if (hasColor) { buffers.colorRed=red.data(); buffers.colorGreen=green.data(); buffers.colorBlue=blue.data(); }
    if (hasIntensity) buffers.intensity=intensity.data();
    if (fields.isColorInvalidField) { check(hasColor,"color-invalid-without-color"); buffers.isColorInvalid=invalidColor.data(); }
    if (fields.isIntensityInvalidField) { check(hasIntensity,"intensity-invalid-without-intensity"); buffers.isIntensityInvalid=invalidIntensity.data(); }
  }
  void reset() { std::fill(invalidColor.begin(),invalidColor.end(),int8_t{0}); std::fill(invalidIntensity.begin(),invalidIntensity.end(),int8_t{0}); }
};

inline void validate_pose(const e57::RigidBodyTransform& pose) {
  const auto& q=pose.rotation;const auto& t=pose.translation;
  check(std::isfinite(q.w)&&std::isfinite(q.x)&&std::isfinite(q.y)&&std::isfinite(q.z)&&std::isfinite(t.x)&&std::isfinite(t.y)&&std::isfinite(t.z),"nonfinite-scan-pose");
  check(std::abs(q.w*q.w+q.x*q.x+q.y*q.y+q.z*q.z-1.0)<=1e-10,"nonunit-scan-pose");
}
inline std::array<double,3> world(const std::array<double,3>& point,const e57::RigidBodyTransform& pose) {
  const auto& q=pose.rotation;const auto& t=pose.translation;
  const std::array<double,3> cross{2*(q.y*point[2]-q.z*point[1]),2*(q.z*point[0]-q.x*point[2]),2*(q.x*point[1]-q.y*point[0])};
  const std::array<double,3> value{point[0]+q.w*cross[0]+q.y*cross[2]-q.z*cross[1]+t.x,
    point[1]+q.w*cross[1]+q.z*cross[0]-q.x*cross[2]+t.y,point[2]+q.w*cross[2]+q.x*cross[1]-q.y*cross[0]+t.z};
  for(double axis:value)check(std::isfinite(axis),"nonfinite-world-coordinate");return value;
}
inline void pose_json(std::ostream& stream,const e57::Data3D& header) {
  stream<<",\"sourceGuid\":";text_json(stream,header.guid);stream<<",\"name\":";text_json(stream,header.name);
  const auto& q=header.pose.rotation;const auto& t=header.pose.translation;
  stream<<",\"pose\":{\"rotationWxyz\":["<<q.w<<','<<q.x<<','<<q.y<<','<<q.z<<"],\"translationMeters\":["<<t.x<<','<<t.y<<','<<t.z<<"]}";
  const auto& c=header.colorLimits;const auto& i=header.intensityLimits;
  for(double v:{c.colorRedMinimum,c.colorRedMaximum,c.colorGreenMinimum,c.colorGreenMaximum,c.colorBlueMinimum,c.colorBlueMaximum,i.intensityMinimum,i.intensityMaximum})check(std::isfinite(v),"nonfinite-attribute-limits");
  stream<<",\"colorLimits\":[["<<c.colorRedMinimum<<','<<c.colorRedMaximum<<"],["<<c.colorGreenMinimum<<','<<c.colorGreenMaximum<<"],["<<c.colorBlueMinimum<<','<<c.colorBlueMaximum<<"]],\"intensityLimits\":["<<i.intensityMinimum<<','<<i.intensityMaximum<<']';
}

// Qualification intermediate only: lossless point records, not the product manifest.
class PointOutput {
  std::filesystem::path destination_,staging_;
  std::ofstream stream_;
  uint64_t bytes_=0;
  bool committed_=false;
public:
  explicit PointOutput(const std::filesystem::path& destination):destination_(destination),staging_(destination.native()+L".partial") {
    check(destination.is_absolute(),"output-must-be-absolute");
    check(!std::filesystem::exists(destination_)&&!std::filesystem::exists(staging_),"output-already-exists");
    check(std::filesystem::create_directory(staging_),"output-create-failed");
    stream_.open(staging_/"points.ndjson",std::ios::binary|std::ios::out);
    if(!stream_.good()){std::filesystem::remove(staging_);throw std::runtime_error("output-open-failed");}
  }
  ~PointOutput() {stream_.close();if(!committed_){std::error_code error;std::filesystem::remove(staging_/"points.ndjson",error);std::filesystem::remove(staging_/"manifest.json",error);std::filesystem::remove(staging_,error);}}
  void chunk(const std::string& value) {
    constexpr uint64_t budget=1024ULL*1024*1024;
    check(value.size()+1<=budget-bytes_,"output-byte-budget");bytes_+=value.size()+1;
    stream_<<value<<'\n';check(stream_.good(),"output-write-failed");
  }
  void commit(const std::string& metadata) {
    check(metadata.size()<=4*1024*1024,"manifest-byte-budget");
    stream_.flush();check(stream_.good(),"output-flush-failed");stream_.close();
    std::ofstream manifest(staging_/"manifest.json",std::ios::binary|std::ios::out);manifest<<metadata<<'\n';manifest.flush();check(manifest.good(),"manifest-write-failed");manifest.close();
    std::filesystem::rename(staging_,destination_);committed_=true;
  }
};

inline void point_json(std::ostream& stream,uint64_t sourceIndex,const std::array<double,3>* position,const Attributes& attributes,size_t i,int8_t invalidCoordinate) {
  stream<<'['<<sourceIndex<<',';
  if(position)stream<<(*position)[0]<<','<<(*position)[1]<<','<<(*position)[2];else stream<<"null,null,null";
  stream<<',';
  if(attributes.hasColor)stream<<attributes.red[i]<<','<<attributes.green[i]<<','<<attributes.blue[i];else stream<<"null,null,null";
  stream<<',';
  if(attributes.hasIntensity&&attributes.invalidIntensity[i]==0){check(std::isfinite(attributes.intensity[i]),"nonfinite-intensity");stream<<attributes.intensity[i];}else stream<<"null";
  check(attributes.invalidColor[i]==0||attributes.invalidColor[i]==1,"invalid-color-state");
  check(attributes.invalidIntensity[i]==0||attributes.invalidIntensity[i]==1,"invalid-intensity-state");
  stream<<','<<(attributes.hasColor&&attributes.invalidColor[i]==0?"true":"false")<<','<<(attributes.hasIntensity&&attributes.invalidIntensity[i]==0?"true":"false")<<','<<int(invalidCoordinate)<<']';
}
}
