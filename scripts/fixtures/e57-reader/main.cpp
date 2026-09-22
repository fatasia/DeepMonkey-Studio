// Qualification reader, not a production importer. Optional bounded point intermediates.
#include <E57SimpleReader.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <filesystem>
#include <iomanip>
#include <iostream>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <vector>
#include <memory>
#include "point_output.h"

namespace {
constexpr size_t chunkSize = 4096;
constexpr uint64_t pointBudget = 100000000;
void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

int read(const std::filesystem::path& path, const std::filesystem::path& outputPath = {}) {
  require(std::filesystem::is_regular_file(path), "input-not-regular-file");
  require(std::filesystem::file_size(path) <= 1024ULL * 1024 * 1024, "input-byte-budget");
  e57::Reader reader(path.u8string(), e57::ReaderOptions{});
  e57::E57Root rootHeader;
  if(!outputPath.empty())require(reader.GetE57Root(rootHeader),"root-metadata-read-failed");
  const int64_t scans = reader.GetData3DCount();
  require(scans >= 0 && scans <= 4096, "scan-count-budget");
  std::vector<double> x(chunkSize), y(chunkSize), z(chunkSize);
  std::vector<int8_t> invalid(chunkSize);
  std::unique_ptr<e57bridge::PointOutput> output;
  if(!outputPath.empty()) output=std::make_unique<e57bridge::PointOutput>(outputPath);
  e57bridge::Attributes attributes(chunkSize);
  uint64_t total = 0, valid = 0, invalidCount = 0;
  std::array<double, 3> low{}, high{};
  low.fill(std::numeric_limits<double>::infinity());
  high.fill(-std::numeric_limits<double>::infinity());
  auto worldLow=low,worldHigh=high;
  std::ostringstream records;
  records<<std::setprecision(17);
  for (int64_t scan = 0; scan < scans; ++scan) {
    e57::Data3D header;
    require(reader.ReadData3D(scan, header), "scan-header-read-failed");
    if(output)e57bridge::validate_pose(header.pose);
    require(header.pointCount <= pointBudget - total, "point-count-budget");
    const auto& fields = header.pointFields;
    const bool cartesian = fields.cartesianXField && fields.cartesianYField && fields.cartesianZField;
    const bool spherical = fields.sphericalRangeField && fields.sphericalAzimuthField && fields.sphericalElevationField;
    require(cartesian || spherical || header.pointCount == 0, "unsupported-coordinate-fields");
    e57::Data3DPointsDouble buffers;
    if(output)attributes.bind(fields,buffers);
    if (cartesian) {
      buffers.cartesianX = x.data(); buffers.cartesianY = y.data(); buffers.cartesianZ = z.data();
      if (fields.cartesianInvalidStateField) buffers.cartesianInvalidState = invalid.data();
    } else if (spherical) {
      buffers.sphericalRange = x.data(); buffers.sphericalAzimuth = y.data(); buffers.sphericalElevation = z.data();
      if (fields.sphericalInvalidStateField) buffers.sphericalInvalidState = invalid.data();
    }
    uint64_t scanPoints = 0;
    {
      auto points = reader.SetUpData3DPointsData(scan, chunkSize, buffers);
      for (;;) {
        std::fill(invalid.begin(), invalid.end(), int8_t{0});
        attributes.reset();
        const auto count = points.read();
        if (count == 0) break;
        require(count <= chunkSize && count <= header.pointCount - scanPoints, "point-count-mismatch");
        const auto firstPoint=scanPoints;scanPoints += count;
        std::ostringstream chunk;chunk<<std::setprecision(17)<<"{\"scan\":"<<scan<<",\"points\":[";
        for (size_t i = 0; i < count; ++i) {
          require(invalid[i]>=0&&invalid[i]<=2,"invalid-coordinate-state");
          if(output&&i)chunk<<',';
          if (invalid[i] != 0) { ++invalidCount;if(output)e57bridge::point_json(chunk,firstPoint+i,nullptr,attributes,i,invalid[i]);continue; }
          std::array<double, 3> value{x[i], y[i], z[i]};
          if (!cartesian) {
            require(x[i] >= 0, "negative-spherical-range");
            value = {x[i] * std::cos(z[i]) * std::cos(y[i]), x[i] * std::cos(z[i]) * std::sin(y[i]), x[i] * std::sin(z[i])};
          }
          for (size_t axis = 0; axis < 3; ++axis) {
            require(std::isfinite(value[axis]), "nonfinite-coordinate");
            low[axis] = std::min(low[axis], value[axis]);
            high[axis] = std::max(high[axis], value[axis]);
          }
          if(output){
            const auto world=e57bridge::world(value,header.pose);
            for(size_t axis=0;axis<3;++axis){worldLow[axis]=std::min(worldLow[axis],world[axis]);worldHigh[axis]=std::max(worldHigh[axis],world[axis]);}
            e57bridge::point_json(chunk,firstPoint+i,&world,attributes,i,0);
          }
          ++valid;
        }
        if(output){chunk<<"]}";output->chunk(chunk.str());}
      }
      points.close();
    }
    require(scanPoints == header.pointCount, "truncated-points");
    total += scanPoints;
    if (scan) records << ',';
    records << "{\"index\":" << scan << ",\"points\":" << scanPoints;
    if(output)e57bridge::pose_json(records,header);
    records << '}';
    require(records.tellp()<=std::streampos(3*1024*1024),"scan-metadata-budget");
  }
  reader.Close();
  std::ostringstream summary;
  summary << std::setprecision(17) << "{\"schemaVersion\":"<<(output?2:1)<<",\"coordinateSpace\":\""<<(output?"world-meters":"scan-local")<<"\",\"poseApplied\":"<<(output?"true":"false")<<",\"chunkPoints\":" << chunkSize
            << ",\"points\":" << total << ",\"validPoints\":" << valid << ",\"invalidPoints\":" << invalidCount << ",\"scans\":[" << records.str() << "],\"localBounds\":";
  if (!valid) summary << "null";
  else summary << "[[" << low[0] << ',' << low[1] << ',' << low[2] << "],[" << high[0] << ',' << high[1] << ',' << high[2] << "]]";
  if(output){summary<<",\"worldBounds\":";if(!valid)summary<<"null";else summary<<"[["<<worldLow[0]<<','<<worldLow[1]<<','<<worldLow[2]<<"],["<<worldHigh[0]<<','<<worldHigh[1]<<','<<worldHigh[2]<<"]]";
    summary<<",\"crs\":null,\"pointFile\":\"points.ndjson\",\"pointColumns\":[\"sourceIndex\",\"x\",\"y\",\"z\",\"redRaw\",\"greenRaw\",\"blueRaw\",\"intensityRaw\",\"colorValid\",\"intensityValid\",\"coordinateInvalidState\"]";}
  if(output){summary<<",\"sourceGuid\":";e57bridge::text_json(summary,rootHeader.guid);summary<<",\"coordinateMetadata\":";e57bridge::text_json(summary,rootHeader.coordinateMetadata);}
  summary << '}';
  if(output){
    output->commit(summary.str());
    std::cout<<"{\"schemaVersion\":2,\"status\":\"inspect\",\"manifest\":\"manifest.json\",\"points\":"<<total<<",\"validPoints\":"<<valid<<",\"invalidPoints\":"<<invalidCount<<",\"scanCount\":"<<scans<<"}\n";
  }else std::cout << summary.str()<<'\n';
  return 0;
}
}

int wmain(int argc, wchar_t** argv) {
  try {
    require(argc == 2 || (argc==4&&std::wstring(argv[2])==L"--output"), "usage: e57-reader input.e57 [--output new-directory]");
    return read(std::filesystem::path(argv[1]),argc==4?std::filesystem::path(argv[3]):std::filesystem::path{});
  } catch (const e57::E57Exception& error) {
    // what() 是上游固定的 "E57 exception"；可读性来自错误码文本与上下文，供解析审计与负例断言。
    std::cerr << "E57-rejected: " << error.errorStr() << " (code " << static_cast<int>(error.errorCode()) << ")\n";
  } catch (const std::exception& error) {
    std::cerr << "input-rejected: " << error.what() << '\n';
  }
  return 1;
}
