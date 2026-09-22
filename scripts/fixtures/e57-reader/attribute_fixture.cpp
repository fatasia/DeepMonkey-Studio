// Synthetic boundary evidence only; real upstream files remain the compatibility fixtures.
#include <E57SimpleWriter.h>
#include "point_output.h"
#include <iostream>

int wmain(int argc,wchar_t** argv) {
  try {
    e57bridge::check(argc==2,"expected-new-fixture-path");
    const std::filesystem::path path(argv[1]);
    e57bridge::check(!std::filesystem::exists(path),"fixture-already-exists");
    e57::Writer writer(path.u8string(),e57::WriterOptions{});
    for(int scan=0;scan<2;++scan){
      e57::Data3D header;header.guid="boundary-"+std::to_string(scan);header.pointCount=3;
      auto& fields=header.pointFields;
      fields.cartesianXField=fields.cartesianYField=fields.cartesianZField=true;
      fields.cartesianInvalidStateField=true;
      fields.colorRedField=fields.colorGreenField=fields.colorBlueField=fields.isColorInvalidField=true;
      fields.intensityField=fields.isIntensityInvalidField=true;
      fields.pointRangeMinimum=-10;fields.pointRangeMaximum=10;
      header.colorLimits={0,65535,0,65535,0,65535};header.intensityLimits={0,100};
      header.pose.rotation={std::sqrt(.5),0,0,std::sqrt(.5)};
      header.pose.translation={1000000.125+scan,-2000000.25,3000000.5};
      e57::Data3DPointsDouble points(header);
      for(int i=0;i<3;++i){
        points.cartesianX[i]=i+1;points.cartesianY[i]=2;points.cartesianZ[i]=3;
        points.cartesianInvalidState[i]=i==2?2:0;
        points.colorRed[i]=65535;points.colorGreen[i]=1234;points.colorBlue[i]=0;
        points.isColorInvalid[i]=i==1?1:0;
        points.intensity[i]=12.5+i;points.isIntensityInvalid[i]=i==1?1:0;
      }
      writer.WriteData3DData(header,points);
    }
    writer.Close();
    e57::RigidBodyTransform bad;bad.rotation.w=2;
    bool rejected=false;try{e57bridge::validate_pose(bad);}catch(const std::runtime_error&){rejected=true;}
    e57bridge::check(rejected,"invalid-quaternion-was-accepted");
    return 0;
  }catch(const e57::E57Exception& error){std::cerr<<error.what();}catch(const std::exception& error){std::cerr<<error.what();}
  return 1;
}
